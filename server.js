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

// --- New: Internal limit for Jackett fetch to ensure enough results for filtering ---
const JACKETT_FETCH_LIMIT = 50; // Fetch top 50 results from Jackett before applying relevance filter

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
 * @param {number} [config.internalMaxResults] - Internal maximum number of results to return from Jackett.
 * @param {number} [config.filterBySeeders=0] - Minimum number of seeders.
 * @param {string} [config.sortBy='publishAt'] - Sort order ('publishAt' or 'seeders').
 * @returns {Promise<Array<Object>>} - A promise that resolves to an array of filtered and sorted torrents.
 */
async function searchJackett(config) {
    const { jackettHost, jackettApiKey, queries, year, internalMaxResults, filterBySeeders = 0, sortBy = 'publishAt' } = config;

    if (!jackettHost || !jackettApiKey) {
        throw new Error('Jackett host and API key must be provided.');
    }
    if (!Array.isArray(queries) || queries.length === 0) {
        throw new Error('Queries must be a non-empty array.');
    }

    let allTorrents = [];
    const seenGuids = new Set(); // To deduplicate torrents across multiple queries

    // Expanded categories for movies and TV shows based on user's input
    const categories = [
        '2000', '2030', '2040', '2045', '2060', // Movies and sub-categories
        '5000', '5030', '5040', '5045', // TV and sub-categories
        '102000', '102060', '102040', '102030', '102045', // Non-standard movie categories
        '105000', '105040', '105030', '105045'  // Non-standard TV categories
    ].join(',');

    for (const q of queries) {
        if (!q || q.trim() === '') continue; // Skip empty or whitespace-only queries

        const searchParams = new URLSearchParams({
            apikey: jackettApiKey,
            t: 'search', // Type for general search
            cat: categories, // Use the expanded list of categories
            q: q
        });

        if (year) {
            searchParams.append('year', year);
        }
        if (internalMaxResults) {
            searchParams.append('limit', internalMaxResults); // Use 'limit' for Jackett's max results
        }


        const jackettUrl = `${jackettHost.replace(/\/+$/, '')}/api/v2.0/indexers/all/results/torznab/api?${searchParams.toString()}`;
        log('debug', `Searching Jackett with query "${q}" and year "${year || 'N/A'}", limit ${internalMaxResults || 'N/A'}, categories: ${categories}: ${jackettUrl}`);

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
            log('warn', `Error searching Jackett with query "${q}": ${error.message}`);
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

    // Note: maxResults for display is applied AFTER this function in the stream endpoint
    return filteredTorrents;
}

/**
 * Normalizes a string for comparison (lowercase, remove non-alphanumeric except spaces).
 * @param {string} str - The string to normalize.
 * @returns {string} - The normalized string.
 */
function normalizeString(str) {
    return str.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
}

/**
 * Checks if a torrent is relevant based on resolved metadata (title and year).
 * @param {Object} torrent - The torrent object from Jackett.
 * @param {Object} resolvedMetadata - Object containing resolvedTitle, resolvedYear, and alternativeTitles.
 * @returns {boolean} - True if the torrent is relevant, false otherwise.
 */
function isTorrentRelevant(torrent, resolvedMetadata) {
    const { resolvedTitle, resolvedYear, alternativeTitles = [] } = resolvedMetadata;
    const torrentTitleNormalized = normalizeString(torrent.title);

    // If no metadata is resolved, assume relevant (fallback behavior)
    if (!resolvedTitle && !resolvedYear) {
        log('debug', `No metadata resolved for relevance check. Assuming torrent "${torrent.title}" is relevant.`);
        return true;
    }

    let titleMatch = false;
    const allRelevantTitles = [resolvedTitle, ...alternativeTitles].filter(Boolean).map(normalizeString);

    for (const relevantTitle of allRelevantTitles) {
        // Check for exact match or strong substring match
        if (torrentTitleNormalized.includes(relevantTitle) || relevantTitle.includes(torrentTitleNormalized)) {
            titleMatch = true;
            break;
        }
    }

    // Attempt to parse year from torrent title if not available from publishAt
    let torrentYear = null;
    if (torrent.publishAt) {
        torrentYear = torrent.publishAt.getFullYear();
    } else {
        const yearMatch = torrent.title.match(/\b(19|20)\d{2}\b/); // Basic year regex
        if (yearMatch) {
            torrentYear = parseInt(yearMatch[0], 10);
        }
    }

    let yearMatch = false;
    if (resolvedYear) {
        if (torrentYear) {
            // Allow a small tolerance for year (e.g., +/- 1 year)
            if (Math.abs(resolvedYear - torrentYear) <= 1) {
                yearMatch = true;
            }
        } else {
            // If torrent year is unknown, but resolved year exists, it's a weak match
            // We might consider this true if title matches strongly, or false if year is critical.
            // For now, let's require a year match if resolvedYear is present.
            yearMatch = false;
        }
    } else {
        // If resolvedYear is not available, don't filter by year
        yearMatch = true;
    }

    const isRelevant = titleMatch && yearMatch;
    if (!isRelevant) {
        log('debug', `Filtering out irrelevant torrent: "${torrent.title}" (TitleMatch: ${titleMatch}, YearMatch: ${yearMatch}, Resolved: "${resolvedTitle}" (${resolvedYear}))`);
    } else {
        log('debug', `Keeping relevant torrent: "${torrent.title}"`);
    }

    return isRelevant;
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
        version: '1.1.0', // Increment version for expanded categories
        name: 'Jackett Direct Torrents (Expanded Categories)',
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

    let resolvedMetadata = {
        resolvedTitle: null,
        resolvedYear: null,
        alternativeTitles: []
    };
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
                let tmdbId = null;

                if (type === 'movie' && data.movie_results && data.movie_results.length > 0) {
                    mediaResult = data.movie_results[0];
                    resolvedMetadata.resolvedTitle = mediaResult.title;
                    resolvedMetadata.resolvedYear = mediaResult.release_date ? parseInt(mediaResult.release_date.substring(0, 4), 10) : null;
                    tmdbId = mediaResult.id;
                } else if (type === 'series' && data.tv_results && data.tv_results.length > 0) {
                    mediaResult = data.tv_results[0];
                    resolvedMetadata.resolvedTitle = mediaResult.name;
                    resolvedMetadata.resolvedYear = mediaResult.first_air_date ? parseInt(mediaResult.first_air_date.substring(0, 4), 10) : null;
                    tmdbId = mediaResult.id;
                }

                if (resolvedMetadata.resolvedTitle) {
                    jackettQueries.unshift(resolvedMetadata.resolvedTitle); // Prioritize resolved title
                    log('info', `[METADATA] Resolved IMDb ID ${imdbId} to (TMDb): "${resolvedMetadata.resolvedTitle}" (${resolvedMetadata.resolvedYear || 'N/A'})`);

                    // Fetch alternative titles from TMDb
                    if (tmdbId) {
                        try {
                            const altTitlesEndpoint = type === 'movie' ?
                                `https://api.themoviedb.org/3/movie/${tmdbId}/alternative_titles?api_key=${tmdbApiKey}` :
                                `https://api.themoviedb.org/3/tv/${tmdbId}/alternative_titles?api_key=${tmdbApiKey}`;
                            const altTitlesResponse = await axios.get(altTitlesEndpoint);
                            const altTitlesData = altTitlesResponse.data;

                            if (altTitlesData.titles && altTitlesData.titles.length > 0) {
                                resolvedMetadata.alternativeTitles = altTitlesData.titles.map(t => t.title).filter(Boolean);
                                log('debug', `[METADATA] Found ${resolvedMetadata.alternativeTitles.length} alternative titles from TMDb.`);
                                // Add alternative titles to Jackett queries as well
                                jackettQueries.unshift(...resolvedMetadata.alternativeTitles);
                            }
                        } catch (altError) {
                            log('warn', `[METADATA ERROR] Error fetching alternative titles from TMDb for ${imdbId}: ${altError.message}`);
                        }
                    }
                } else {
                    log('debug', `[METADATA] TMDb found no results for IMDb ID ${imdbId} or type mismatch.`);
                }
            } catch (error) {
                log('warn', `[METADATA ERROR] Error fetching from TMDb for ${imdbId}: ${error.message}`);
            }
        }

        // 2. If TMDb failed or not configured, try OMDb API
        if (!resolvedMetadata.resolvedTitle && omdbApiKey) {
            try {
                const omdbResponse = await axios.get(`http://www.omdbapi.com/?i=${imdbId}&apikey=${omdbApiKey}`);
                const data = omdbResponse.data;

                if (data.Response === 'True') {
                    resolvedMetadata.resolvedTitle = data.Title;
                    resolvedMetadata.resolvedYear = parseInt(data.Year, 10);
                    jackettQueries.unshift(resolvedMetadata.resolvedTitle); // Prioritize resolved title
                    log('info', `[METADATA] Resolved IMDb ID ${imdbId} to (OMDb): "${resolvedMetadata.resolvedTitle}" (${resolvedMetadata.resolvedYear || 'N/A'})`);
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
            year: resolvedMetadata.resolvedYear, // Pass resolved year if available
            internalMaxResults: JACKETT_FETCH_LIMIT, // Use internal limit for Jackett fetch
            filterBySeeders: parsedFilterBySeeders,
            sortBy
        };

        let torrents = await searchJackett(jackettConfig);
        log('info', `[JACKETT RESULTS] Found ${torrents.length} initial torrents from Jackett (fetched up to ${JACKETT_FETCH_LIMIT}).`);
        torrents.forEach((t, i) => log('debug', `  Initial Torrent ${i + 1}: ${t.title} (Seeders: ${t.seeders}, Link: ${t.link ? t.link.substring(0, 60) + '...' : 'N/A'})`));

        // --- Post-filtering based on resolved metadata ---
        if (resolvedMetadata.resolvedTitle || resolvedMetadata.resolvedYear) {
            const relevantTorrents = torrents.filter(torrent => isTorrentRelevant(torrent, resolvedMetadata));
            log('info', `[RELEVANCE FILTER] Filtered ${torrents.length - relevantTorrents.length} irrelevant torrents. Remaining relevant: ${relevantTorrents.length}`);
            torrents = relevantTorrents;
        } else {
            log('info', '[RELEVANCE FILTER] No resolved metadata, skipping relevance filter.');
        }
        // --- End Post-filtering ---


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

        // --- Apply user's maxResults after all filtering and processing ---
        const finalStreams = streams.slice(0, parsedMaxResults);
        log('info', `[STREMIO RESPONSE] Sending ${finalStreams.length} streams to Stremio (limited by user's maxResults of ${parsedMaxResults}).`);
        log('debug', `[STREMIO RESPONSE] Full streams array:`, JSON.stringify(finalStreams, null, 2));
        res.json({ streams: finalStreams });
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

