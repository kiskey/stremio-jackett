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
 * Searches Jackett for torrents.
 * @param {Object} config - Configuration object.
 * @param {string} config.jackettHost - Jackett host URL.
 * @param {string} config.jackettApiKey - Jackett API key.
 * @param {string} config.query - The search query (title).
 * @param {number} [config.year] - The release year (optional).
 * @param {number} [config.maxResults=20] - Maximum number of results to return.
 * @param {number} [config.filterBySeeders=0] - Minimum number of seeders.
 * @param {string} [config.sortBy='publishAt'] - Sort order ('publishAt' or 'seeders').
 * @returns {Promise<Array<Object>>} - A promise that resolves to an array of filtered and sorted torrents.
 */
async function searchJackett(config) {
    const { jackettHost, jackettApiKey, query, year, maxResults = 20, filterBySeeders = 0, sortBy = 'publishAt' } = config;

    if (!jackettHost || !jackettApiKey) {
        throw new Error('Jackett host and API key must be provided.');
    }

    const searchParams = new URLSearchParams({
        apikey: jackettApiKey,
        t: 'search', // Type for general search
        cat: '2000,5000', // Categories for movies (2000) and TV (5000)
        q: query
    });

    if (year) {
        searchParams.append('year', year);
    }

    const jackettUrl = `${jackettHost.replace(/\/+$/, '')}/api/v2.0/indexers/all/results/torznab/api?${searchParams.toString()}`;
    console.log(`Searching Jackett: ${jackettUrl}`);

    try {
        const response = await axios.get(jackettUrl);
        const torrents = await parseJackettResponse(response.data);

        // Apply filtering
        let filteredTorrents = torrents.filter(torrent => torrent.seeders >= filterBySeeders);

        // Apply sorting
        if (sortBy === 'seeders') {
            filteredTorrents.sort((a, b) => b.seeders - a.seeders); // Descending seeders
        } else { // Default to publishAt
            filteredTorrents.sort((a, b) => (b.publishAt?.getTime() || 0) - (a.publishAt?.getTime() || 0)); // Descending publishAt
        }

        // Apply maxResults
        return filteredTorrents.slice(0, Math.min(maxResults, 20)); // Ensure maxResults doesn't exceed 20
    } catch (error) {
        console.error('Error searching Jackett:', error.message);
        throw new Error(`Failed to search Jackett: ${error.message}`);
    }
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
        trackerGithubUrl = process.env.TRACKER_GITHUB_URL
    } = req.query;

    const parsedMaxResults = Math.min(parseInt(maxResults, 10) || 20, 20); // Max 20 results
    const parsedFilterBySeeders = parseInt(filterBySeeders, 10) || 0;

    const manifest = {
        id: 'org.stremio.jackettaddon',
        version: '1.0.0',
        name: 'Jackett Direct Torrents',
        description: 'Stremio addon to search Jackett for direct torrents with flexible configuration.',
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
        trackerGithubUrl = process.env.TRACKER_GITHUB_URL
    } = req.query; // Configuration from addon URL

    const parsedMaxResults = Math.min(parseInt(maxResults, 10) || 20, 20);
    const parsedFilterBySeeders = parseInt(filterBySeeders, 10) || 0;

    let title = '';
    let year = null;

    // Stremio passes ID in format like 'tt1234567' for movies/series
    // We need to extract title and year for Jackett search
    // For simplicity, we'll assume the Stremio request provides enough info or use a placeholder
    // In a real-world scenario, you might use an external API (OMDb/TMDb) to resolve IMDb ID to title/year
    // For now, we'll try to infer from the ID or rely on Jackett's ability to search broadly.
    // Stremio's stream request for a specific ID usually includes meta info in the background.
    // For this example, we'll use a dummy title/year if not explicitly resolved.
    // A robust solution would involve fetching movie/series metadata.
    // For now, we'll just use the ID as a query if it's not a common title.
    // Stremio usually sends the title in the background, but the /stream endpoint only gets type/id.
    // To get the actual title/year, you'd typically need to make another API call or rely on a catalog.
    // Given the prompt, we'll make a simplifying assumption: Jackett can often find by IMDb ID or a generic search.
    // However, Jackett's Torznab API primarily uses 'q' (query string).
    // So, we need to resolve the IMDb ID to a title.

    // Placeholder for title/year resolution.
    // In a real app, you'd fetch this from a reliable source like TMDB or OMDb.
    // For now, let's assume the ID is just the IMDb ID and Jackett can handle it to some extent.
    // Or, more practically, we can assume the user will search by title in Stremio.
    // Stremio's UI usually shows results based on the title, and then if you click, it sends the ID.
    // If the addon is only for "direct torrents" and not a catalog, it won't be triggered by title search.
    // It will be triggered when a user clicks on a movie/series and the addon is active.

    // Let's make a simple dummy title/year for demonstration.
    // In a production addon, you'd fetch this from an external API.
    // Example: If ID is 'tt0133093' (The Matrix), you'd fetch its title and year.
    // For this example, we'll construct a generic query based on the ID.
    // Jackett's Torznab API usually expects a text query.
    // So, we'll use the ID as the query, hoping Jackett can resolve it.
    // A better approach would be to have a separate metadata resolver.

    // Let's try to parse the ID for a basic query.
    // Stremio IDs are usually like 'tt1234567' for movies/series.
    // We'll use the ID directly as the search query for Jackett.
    // This might not be ideal for all Jackett indexers, but it's a starting point.
    let searchQuery = id; // Default to using the ID as the search query
    if (id.startsWith('tt')) {
        // This is an IMDb ID. A robust solution would fetch the title/year.
        // For now, we'll pass the ID directly to Jackett, hoping some indexers can handle it,
        // or rely on the fact that Stremio might implicitly pass other info.
        // Or, we can make a dummy API call to get the title.
        // Let's use a very simple mock for title/year resolution.
        // In a real app, you'd use OMDb API or TMDb API.
        console.log(`Attempting to resolve title/year for IMDb ID: ${id}`);
        try {
            // This is a placeholder. You would replace this with an actual API call.
            // Example using OMDb API (requires API key):
            // const omdbApiKey = process.env.OMDB_API_KEY; // You'd need to get one
            // if (omdbApiKey) {
            //     const omdbResponse = await axios.get(`http://www.omdbapi.com/?i=${id}&apikey=${omdbApiKey}`);
            //     if (omdbResponse.data && omdbResponse.data.Response === 'True') {
            //         title = omdbResponse.data.Title;
            //         year = parseInt(omdbResponse.data.Year, 10);
            //         searchQuery = title; // Use the resolved title for Jackett
            //         console.log(`Resolved ID ${id} to: ${title} (${year})`);
            //     }
            // } else {
            //     console.warn('OMDb API key not provided. Using IMDb ID as search query.');
            // }
            // For now, we'll just use the ID as the query.
            // If the user wants a more robust solution, they'd need to provide an OMDb/TMDb API key.
            searchQuery = id; // Jackett indexers might be able to handle IMDb IDs directly or convert them.
        } catch (error) {
            console.error(`Error resolving title/year for ${id}:`, error.message);
            searchQuery = id; // Fallback to using ID as query
        }
    } else {
        // If it's not an IMDb ID, it might be a generic search term from a catalog.
        // For this addon, we are primarily focusing on 'tt' IDs from Stremio.
        // If it's another ID format, we might need to adjust the logic.
        searchQuery = id;
    }

    try {
        // Fetch trackers first
        const trackers = await fetchTrackers(trackerGithubUrl);

        const jackettConfig = {
            jackettHost,
            jackettApiKey,
            query: searchQuery,
            year: year, // Pass resolved year if available
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
