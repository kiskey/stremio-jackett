// server.js
require('dotenv').config(); // Load environment variables from .env file for local development

const express = require('express');
const axios = require('axios');
const xml2js = require('xml2js');
const { URLSearchParams } = require('url');
const cors = require('cors'); // Import the cors middleware

const app = express();
const PORT = process.env.PORT || 80;

// --- Configurable Logging Setup ---
const LOG_LEVELS = {
    'error': 0,
    'warn': 1,
    'info': 2,
    'debug': 3
};
// Get log level from environment variable, default to 'info'
const currentLogLevel = LOG_LEVELS[process.env.LOG_LEVEL?.toLowerCase()] || LOG_LEVELS['info'];

/**
 * Custom logging function based on configured log level.
 * @param {string} level - The log level ('error', 'warn', 'info', 'debug').
 * @param {string} message - The log message.
 * @param {any[]} optionalParams - Additional parameters to log.
 */
function log(level, message, ...optionalParams) {
    if (LOG_LEVELS[level] <= currentLogLevel) {
        const timestamp = new Date().toISOString();
        const formattedMessage = `[${timestamp}] [${level.toUpperCase()}] ${message}`;
        if (level === 'error') {
            console.error(formattedMessage, ...optionalParams);
        } else if (level === 'warn') {
            console.warn(formattedMessage, ...optionalParams);
        } else {
            console.log(formattedMessage, ...optionalParams);
        }
    }
}
// --- End Configurable Logging Setup ---


// Enable CORS for all origins
// This is crucial for Stremio to be able to fetch resources from your addon.
app.use(cors());

// Global cache for trackers
let cachedTrackers = [];
let lastTrackerFetch = 0;
const TRACKER_CACHE_DURATION = 1 * 60 * 60 * 1000; // 1 hour in milliseconds

/**
 * Extracts the info hash from a magnet URI.
 * @param {string} magnetUri - The magnet URI.
 * @returns {string|null} - The info hash or null if not found.
 */
function getInfoHashFromMagnet(magnetUri) {
    const match = magnetUri.match(/xt=urn:btih:([a-fA-F0-9]{40})/);
    return match ? match[1] : null;
}

/**
 * Fetches the list of best trackers from a GitHub URL.
 * The URL should point to a raw text file where each line is a tracker URL.
 * @param {string} githubUrl - The raw GitHub URL to the trackers file.
 * @returns {Promise<string[]>} - A promise that resolves to an array of tracker URLs.
 */
async function fetchTrackers(githubUrl) {
    if (!githubUrl) {
        log('warn', 'No trackerGithubUrl provided. Skipping tracker fetching.');
        return [];
    }

    const now = Date.now();
    if (cachedTrackers.length > 0 && (now - lastTrackerFetch < TRACKER_CACHE_DURATION)) {
        log('debug', 'Using cached trackers.');
        return cachedTrackers;
    }

    try {
        log('info', `Fetching trackers from: ${githubUrl}`);
        const response = await axios.get(githubUrl);
        const trackers = response.data.split('\n')
            .map(line => line.trim())
            .filter(line => line.startsWith('udp://') || line.startsWith('http://') || line.startsWith('https://')); // Basic validation
        
        cachedTrackers = trackers;
        lastTrackerFetch = now;
        log('info', `Successfully fetched ${trackers.length} trackers.`);
        return trackers;
    } catch (error) {
        log('error', `Error fetching trackers from ${githubUrl}:`, error.message);
        // Fallback to previous cached trackers if available, or empty array
        return cachedTrackers.length > 0 ? cachedTrackers : [];
    }
}

/**
 * Appends a list of trackers to a magnet URI.
 * This function is now primarily for internal use to get a complete magnet string,
 * but the individual trackers will be used for the 'sources' field in Stremio.
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
        log('debug', `Searching Jackett with query "${q}" and year "${year || 'N/A'}": ${jackettUrl}`);

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
            log('warn', `Error searching Jackett with query "${q}":`, error.message);
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
        version: '1.0.7', // Increment version for configurable logging
        name: 'Jackett Direct Torrents (Configurable Logging)',
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
                },
                // You could add LOG_LEVEL here as a configurable option if desired,
                // but environment variables are generally preferred for logging levels.
                // {
                //     key: 'logLevel',
                //     type: 'select',
                //     title: 'Logging Level',
                //     options: [
                //         { value: 'error', label: 'Error' },
                //         { value: 'warn', label: 'Warning' },
                //         { value: 'info', label: 'Info (Default)' },
                //         { value: 'debug', label: 'Debug (Verbose)' }
                //     ],
                //     required: false,
                //     default: 'info'
                // }
            ]
        }
    };
    res.json(manifest);
});

// Stremio Stream Endpoint
app.get('/stream/:type/:id.json', async (req, res) => {
    const { type, id } = req.params;
    log('info', `[STREAM REQUEST] Received request for Type: ${type}, ID: ${id}`);

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
        log('info', `[METADATA] Attempting to resolve metadata for IMDb ID: ${imdbId}`);

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
                    log('info', `[METADATA] Resolved IMDb ID ${imdbId} to (TMDb): "${resolvedTitle}" (${resolvedYear || 'N/A'})`);
                } else {
                    log('debug', `[METADATA] TMDb found no results for IMDb ID ${imdbId} or type mismatch.`);
                }
            } catch (error) {
                log('warn', `[METADATA ERROR] Error fetching from TMDb for ${imdbId}: ${error.message}`);
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
                    log('info', `[METADATA] Resolved IMDb ID ${imdbId} to (OMDb): "${resolvedTitle}" (${resolvedYear || 'N/A'})`);
                } else {
                    log('debug', `[METADATA] OMDb found no results for IMDb ID ${imdbId}: ${data.Error}`);
                }
            } catch (error) {
                log('warn', `[METADATA ERROR] Error fetching from OMDb for ${imdbId}: ${error.message}`);
            }
        }
    }

    // Ensure unique queries and remove null/empty strings
    jackettQueries = [...new Set(jackettQueries.filter(q => q && q.trim() !== ''))];
    log('info', '[JACKETT QUERY] Final Jackett queries for search:', jackettQueries);

    try {
        // Fetch trackers first
        const trackers = await fetchTrackers(trackerGithubUrl);
        log('info', `[TRACKERS] Using ${trackers.length} trackers.`);

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
        log('info', `[JACKETT RESULTS] Found ${torrents.length} torrents from Jackett.`);
        torrents.forEach((t, i) => log('debug', `  Torrent ${i + 1}: ${t.title} (Seeders: ${t.seeders}, Link: ${t.link ? t.link.substring(0, 60) + '...' : 'N/A'})`));


        const streams = torrents.map(torrent => {
            const infoHash = getInfoHashFromMagnet(torrent.link);
            if (!infoHash) {
                log('warn', `[STREAM ERROR] Could not extract infoHash for torrent: ${torrent.title}. Skipping stream.`);
                return null; // Skip this stream if infoHash is not found
            }

            // Prepare sources array for Stremio
            const streamSources = trackers.map(t => `tracker:${t}`);
            streamSources.push(`dht:${infoHash}`); // Add DHT source

            log('debug', `[STREAM OUTPUT] Processing torrent "${torrent.title}". InfoHash: ${infoHash}, Sources: ${JSON.stringify(streamSources)}`);

            return {
                name: 'Jackett', // Display name of the addon
                title: `${torrent.title} (${torrent.seeders} Seeders)`,
                infoHash: infoHash, // Explicitly include infoHash
                sources: streamSources // Provide trackers and DHT as sources
                // fileIdx: (optional, Stremio picks largest if not specified)
            };
        }).filter(s => s !== null); // Filter out any null streams (where infoHash extraction failed)

        log('info', `[STREMIO RESPONSE] Sending ${streams.length} streams to Stremio.`);
        log('debug', `[STREMIO RESPONSE] Full streams array:`, JSON.stringify(streams, null, 2));
        res.json({ streams });
    } catch (error) {
        log('error', '[GLOBAL ERROR] Error in /stream endpoint:', error.message);
        res.status(500).json({ streams: [], error: error.message });
    }
});

// Basic health check endpoint
app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

// Start the server
app.listen(PORT, () => {
    log('info', `Stremio Jackett Addon listening on port ${PORT}`);
    // Initial fetch of trackers on startup
    fetchTrackers(process.env.TRACKER_GITHUB_URL || '');
});

