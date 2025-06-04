// server.js
require('dotenv').config(); // Load environment variables from .env file for local development

const express = require('express');
const axios = require('axios');
const xml2js = require('xml2js');
const { URLSearchParams } = require('url');

const app = express();
const PORT = process.env.PORT || 80;

// Global cache for trackers
let cachedTrackers = [];
let lastTrackerFetch = 0;
const TRACKER_CACHE_DURATION = 1 * 60 * 60 * 1000; // 1 hour in milliseconds

/**
 * Fetches the list of best trackers from a GitHub URL.
 * The URL should point to a raw text file where each line is a tracker URL.
 * @param {string} githubUrl - The raw GitHub URL to the trackers file.
 * @returns {Promise<string[]>} - A promise that resolves to an array of tracker URLs.
 */
async function fetchTrackers(githubUrl) {
    if (!githubUrl) {
        console.warn('No trackerGithubUrl provided. Skipping tracker fetching.');
        return [];
    }

    const now = Date.now();
    if (cachedTrackers.length > 0 && (now - lastTrackerFetch < TRACKER_CACHE_DURATION)) {
        console.log('Using cached trackers.');
        return cachedTrackers;
    }

    try {
        console.log(`Fetching trackers from: ${githubUrl}`);
        const response = await axios.get(githubUrl);
        const trackers = response.data.split('\n')
            .map(line => line.trim())
            .filter(line => line.startsWith('udp://') || line.startsWith('http://') || line.startsWith('https://')); // Basic validation
        
        cachedTrackers = trackers;
        lastTrackerFetch = now;
        console.log(`Successfully fetched ${trackers.length} trackers.`);
        return trackers;
    } catch (error) {
        console.error(`Error fetching trackers from ${githubUrl}:`, error.message);
        // Fallback to previous cached trackers if available, or empty array
        return cachedTrackers.length > 0 ? cachedTrackers : [];
    }
}

/**
 * Appends a list of trackers to a magnet URI.
 * @param {string} magnetUri - The original magnet URI.
 * @param {string[]} trackers - An array of tracker URLs.
 * @returns {string} - The magnet URI with appended trackers.
 */
function appendTrackersToMagnet(magnetUri, trackers) {
    if (!magnetUri || !trackers || trackers.length === 0) {
        return magnetUri;
    }

    let newMagnetUri = magnetUri;
    trackers.forEach(tracker => {
        if (!newMagnetUri.includes(`tr=${encodeURIComponent(tracker)}`)) {
            newMagnetUri += `&tr=${encodeURIComponent(tracker)}`;
        }
    });
    return newMagnetUri;
}

/**
 * Parses Jackett's Torznab XML response and extracts relevant torrent information.
 * @param {string} xmlString - The XML response from Jackett.
 * @returns {Promise<Array<Object>>} - A promise that resolves to an array of parsed torrent objects.
 */
async function parseJackettResponse(xmlString) {
    return new Promise((resolve, reject) => {
        xml2js.parseString(xmlString, { explicitArray: false, mergeAttrs: true }, (err, result) => {
            if (err) {
                return reject(err);
            }
            const items = result?.rss?.channel?.item || [];
            const torrents = Array.isArray(items) ? items : [items]; // Ensure items is always an array

            const parsedTorrents = torrents.map(item => {
                const magnetUri = item.magnetUri || item.link; // Jackett often provides magnetUri directly
                const seeders = parseInt(item['torznab:attr']?.find(attr => attr.name === 'seeders')?.value || 0, 10);
                const publishDate = item.pubDate ? new Date(item.pubDate) : null;

                return {
                    title: item.title,
                    link: magnetUri, // Use magnetUri if available, otherwise fallback to link
                    size: item.size,
                    seeders: seeders,
                    peers: parseInt(item['torznab:attr']?.find(attr => attr.name === 'peers')?.value || 0, 10),
                    publishAt: publishDate,
                    guid: item.guid // Unique identifier for the torrent
                };
            }).filter(torrent => torrent.link && torrent.link.startsWith('magnet:')); // Filter for direct magnet links
            
            resolve(parsedTorrents);
        });
    });
}

/**
 * Searches Jackett for torrents using an array of queries.
 * @param {Object} config - Configuration object.
 * @param {string} config.jackettHost - Jackett host URL.
 * @param {string} config.jackettApiKey - Jackett API key.
 * @param {string[]} config.queries - An array of search queries (titles, IDs).
 * @param {number} [config.year] - The release year (optional).
 * @param {number} [config.maxResults=20] - Maximum number of results to return.
 * @param {number} [config.filterBySeeders=0] - Minimum number of seeders.
 * @param {string} [config.sortBy='publishAt'] - Sort order ('publishAt' or 'seeders').
 * @returns {Promise<Array<Object>>} - A promise that resolves to an array of filtered and sorted torrents.
 */
async function searchJackett(config) {
    const { jackettHost, jackettApiKey, queries, year, maxResults = 20, filterBySeeders = 0, sortBy = 'publishAt' } = config;

    if (!jackettHost || !jackettApiKey) {
        throw new Error('Jackett host and API key must be provided.');
    }
    if (!Array.isArray(queries) || queries.length === 0) {
        throw new Error('Queries must be a non-empty array.');
    }

    let allTorrents = [];
    const seenGuids = new Set(); // To deduplicate torrents across multiple queries

    for (const q of queries) {
        if (!q || q.trim() === '') continue; // Skip empty or whitespace-only queries

        const searchParams = new URLSearchParams({
            apikey: jackettApiKey,
            t: 'search', // Type for general search
            cat: '2000,5000', // Categories for movies (2000) and TV (5000)
            q: q
        });

        if (year) {
            searchParams.append('year', year);
        }

        const jackettUrl = `${jackettHost.replace(/\/+$/, '')}/api/v2.0/indexers/all/results/torznab/api?${searchParams.toString()}`;
        console.log(`Searching Jackett with query "${q}" and year "${year || 'N/A'}": ${jackettUrl}`);

        try {
            const response = await axios.get(jackettUrl);
            const torrents = await parseJackettResponse(response.data);

            torrents.forEach(torrent => {
                if (!seenGuids.has(torrent.guid)) {
                    allTorrents.push(torrent);
                    seenGuids.add(torrent.guid);
                }
            });
        } catch (error) {
            console.warn(`Error searching Jackett with query "${q}":`, error.message);
            // Continue to the next query even if one fails
        }
    }

    // Apply filtering
    let filteredTorrents = allTorrents.filter(torrent => torrent.seeders >= filterBySeeders);

    // Apply sorting
    if (sortBy === 'seeders') {
        filteredTorrents.sort((a, b) => b.seeders - a.seeders); // Descending seeders
    } else { // Default to publishAt
        filteredTorrents.sort((a, b) => (b.publishAt?.getTime() || 0) - (a.publishAt?.getTime() || 0)); // Descending publishAt
    }

    // Apply maxResults
    return filteredTorrents.slice(0, Math.min(maxResults, 20)); // Ensure maxResults doesn't exceed 20
}

// Stremio Manifest
app.get('/manifest.json', (req, res) => {
    // Parse configuration from query parameters
    const {
        jackettHost = process.env.JACKETT_HOST,
        jackettApiKey = process.env.JACKETT_API_KEY,
        maxResults = '20', // Default as string, parse later
        filterBySeeders = '0',
        sortBy = 'publishAt', // Default sort
        trackerGithubUrl = process.env.TRACKER_GITHUB_URL,
        tmdbApiKey = process.env.TMDB_API_KEY, // New config
        omdbApiKey = process.env.OMDB_API_KEY // New config
    } = req.query;

    const parsedMaxResults = Math.min(parseInt(maxResults, 10) || 20, 20); // Max 20 results
    const parsedFilterBySeeders = parseInt(filterBySeeders, 10) || 0;

    const manifest = {
        id: 'org.stremio.jackettaddon',
        version: '1.0.1', // Increment version
        name: 'Jackett Direct Torrents (Enhanced)',
        description: 'Stremio addon to search Jackett for direct torrents with flexible configuration and metadata resolution.',
        resources: ['stream'],
        types: ['movie', 'series'],
        catalogs: [], // No catalogs, only direct search
        idPrefixes: ['tt'], // Supports IMDb IDs
        behaviorHints: {
            configurable: true,
            // Configuration options passed via query parameters in the addon URL
            // These will be shown in the Stremio addon configuration UI
            configuration: [
                {
                    key: 'jackettHost',
                    type: 'text',
                    title: 'Jackett Host URL (e.g., http://localhost:9117)',
                    required: true,
                    default: jackettHost || ''
                },
                {
                    key: 'jackettApiKey',
                    type: 'text',
                    title: 'Jackett API Key',
                    required: true,
                    default: jackettApiKey || ''
                },
                {
                    key: 'tmdbApiKey',
                    type: 'text',
                    title: 'TMDb API Key (optional, for better title resolution)',
                    required: false,
                    default: tmdbApiKey || ''
                },
                {
                    key: 'omdbApiKey',
                    type: 'text',
                    title: 'OMDb API Key (optional, fallback to TMDb)',
                    required: false,
                    default: omdbApiKey || ''
                },
                {
                    key: 'maxResults',
                    type: 'number',
                    title: 'Max Results (default: 20, max: 20)',
                    required: false,
                    default: parsedMaxResults.toString(),
                    min: 1,
                    max: 20
                },
                {
                    key: 'filterBySeeders',
                    type: 'number',
                    title: 'Minimum Seeders (optional)',
                    required: false,
                    default: parsedFilterBySeeders.toString(),
                    min: 0
                },
                {
                    key: 'sortBy',
                    type: 'select',
                    title: 'Sort By',
                    options: [
                        { value: 'publishAt', label: 'Recently Published' },
                        { value: 'seeders', label: 'Most Seeders' }
                    ],
                    required: false,
                    default: sortBy
                },
                {
                    key: 'trackerGithubUrl',
                    type: 'text',
                    title: 'GitHub Raw URL for Trackers (optional)',
                    description: 'e.g., https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_all.txt',
                    required: false,
                    default: trackerGithubUrl || ''
                }
            ]
        }
    };
    res.json(manifest);
});

// Stremio Stream Endpoint
app.get('/stream/:type/:id.json', async (req, res) => {
    const { type, id } = req.params;
    const {
        jackettHost = process.env.JACKETT_HOST,
        jackettApiKey = process.env.JACKETT_API_KEY,
        maxResults = '20',
        filterBySeeders = '0',
        sortBy = 'publishAt',
        trackerGithubUrl = process.env.TRACKER_GITHUB_URL,
        tmdbApiKey = process.env.TMDB_API_KEY,
        omdbApiKey = process.env.OMDB_API_KEY
    } = req.query; // Configuration from addon URL

    const parsedMaxResults = Math.min(parseInt(maxResults, 10) || 20, 20);
    const parsedFilterBySeeders = parseInt(filterBySeeders, 10) || 0;

    let resolvedTitle = null;
    let resolvedYear = null;
    let jackettQueries = [id]; // Start with the ID as a fallback query

    // Attempt to resolve title and year using TMDb or OMDb if it's an IMDb ID
    if (id.startsWith('tt')) { // Likely an IMDb ID
        const imdbId = id;
        console.log(`Attempting to resolve metadata for IMDb ID: ${imdbId}`);

        // 1. Try TMDb API first
        if (tmdbApiKey) {
            try {
                const tmdbResponse = await axios.get(`https://api.themoviedb.org/3/find/${imdbId}?external_source=imdb_id&api_key=${tmdbApiKey}`);
                const data = tmdbResponse.data;

                let mediaResult = null;
                if (type === 'movie' && data.movie_results && data.movie_results.length > 0) {
                    mediaResult = data.movie_results[0];
                    resolvedTitle = mediaResult.title;
                    resolvedYear = mediaResult.release_date ? parseInt(mediaResult.release_date.substring(0, 4), 10) : null;
                } else if (type === 'series' && data.tv_results && data.tv_results.length > 0) {
                    mediaResult = data.tv_results[0];
                    resolvedTitle = mediaResult.name;
                    resolvedYear = mediaResult.first_air_date ? parseInt(mediaResult.first_air_date.substring(0, 4), 10) : null;
                }

                if (resolvedTitle) {
                    jackettQueries.unshift(resolvedTitle); // Prioritize resolved title
                    console.log(`Resolved IMDb ID ${imdbId} to (TMDb): "${resolvedTitle}" (${resolvedYear || 'N/A'})`);
                } else {
                    console.log(`TMDb found no results for IMDb ID ${imdbId} or type mismatch.`);
                }
            } catch (error) {
                console.warn(`Error fetching from TMDb for ${imdbId}:`, error.message);
            }
        }

        // 2. If TMDb failed or not configured, try OMDb API
        if (!resolvedTitle && omdbApiKey) {
            try {
                const omdbResponse = await axios.get(`http://www.omdbapi.com/?i=${imdbId}&apikey=${omdbApiKey}`);
                const data = omdbResponse.data;

                if (data.Response === 'True') {
                    resolvedTitle = data.Title;
                    resolvedYear = parseInt(data.Year, 10);
                    jackettQueries.unshift(resolvedTitle); // Prioritize resolved title
                    console.log(`Resolved IMDb ID ${imdbId} to (OMDb): "${resolvedTitle}" (${resolvedYear || 'N/A'})`);
                } else {
                    console.log(`OMDb found no results for IMDb ID ${imdbId}: ${data.Error}`);
                }
            } catch (error) {
                console.warn(`Error fetching from OMDb for ${imdbId}:`, error.message);
            }
        }
    }

    // Ensure unique queries and remove null/empty strings
    jackettQueries = [...new Set(jackettQueries.filter(q => q && q.trim() !== ''))];
    console.log('Final Jackett queries for search:', jackettQueries);

    try {
        // Fetch trackers first
        const trackers = await fetchTrackers(trackerGithubUrl);

        const jackettConfig = {
            jackettHost,
            jackettApiKey,
            queries: jackettQueries, // Pass the array of queries
            year: resolvedYear, // Pass resolved year if available
            maxResults: parsedMaxResults,
            filterBySeeders: parsedFilterBySeeders,
            sortBy
        };

        const torrents = await searchJackett(jackettConfig);

        const streams = torrents.map(torrent => {
            let magnetLink = torrent.link;
            if (trackers.length > 0) {
                magnetLink = appendTrackersToMagnet(magnetLink, trackers);
            }

            return {
                name: 'Jackett', // Display name of the addon
                title: `${torrent.title} (${torrent.seeders} Seeders)`,
                url: magnetLink
            };
        });

        res.json({ streams });
    } catch (error) {
        console.error('Error in /stream endpoint:', error.message);
        res.status(500).json({ streams: [], error: error.message });
    }
});

// Basic health check endpoint
app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

// Start the server
app.listen(PORT, () => {
    console.log(`Stremio Jackett Addon listening on port ${PORT}`);
    // Initial fetch of trackers on startup
    fetchTrackers(process.env.TRACKER_GITHUB_URL || '');
});
