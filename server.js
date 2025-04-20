// server.js
const express = require('express');
const path = require('path');
const fs = require('fs').promises; // Use promises
const fse = require('fs-extra'); // Use fs-extra for existsSync check
const { marked } = require('marked'); // Markdown parser
const dayjs = require('dayjs'); // Date formatting/parsing
const customParseFormat = require('dayjs/plugin/customParseFormat');
dayjs.extend(customParseFormat);

const { config } = require('./config'); // Your existing config

const app = express();
const port = process.env.PORT || 3000; // Allow port override via environment variable

const DATA_DIR = path.resolve(__dirname, config.scraper.outputBaseDir);

// --- Middleware ---
app.set('view engine', 'ejs'); // Set EJS as the templating engine
app.set('views', path.join(__dirname, 'views')); // Tell Express where to find EJS files
app.use('/static', express.static(path.join(__dirname, 'public'))); // Serve static files (CSS, JS) from /public under /static URL path

// --- Helper Functions ---

/** Get list of valid YYYY-MM-DD date directories, sorted descending */
async function getAvailableDates() {
    try {
        const entries = await fs.readdir(DATA_DIR, { withFileTypes: true });
        const dateDirs = entries
            .filter(dirent => dirent.isDirectory() && dayjs(dirent.name, 'YYYY-MM-DD', true).isValid()) // Check if it's a directory and valid date format
            .map(dirent => dirent.name)
            .sort((a, b) => b.localeCompare(a)); // Sort descending (newest first)
        return dateDirs;
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.warn(`Data directory "${DATA_DIR}" not found. No dates available.`);
            return [];
        }
        console.error("Error reading date directories:", error);
        return [];
    }
}

/** Get list of source directories within a specific date directory */
async function getSourcesForDate(date) {
    const datePath = path.join(DATA_DIR, date);
    try {
        // Ensure the date directory itself exists before trying to read it
        if (!fse.existsSync(datePath)) return [];
        const entries = await fs.readdir(datePath, { withFileTypes: true });
        const sourceDirs = entries
            .filter(dirent => dirent.isDirectory() && dirent.name !== 'archive') // Filter for directories, exclude 'archive' if present
            .map(dirent => dirent.name)
            .sort(); // Sort sources alphabetically
        return sourceDirs;
    } catch (error) {
        console.error(`Error reading sources for date ${date}:`, error);
        return [];
    }
}

/** Find the first .md file matching a pattern, read it, and convert to HTML */
async function findAndReadMarkdown(directory, baseNamePattern) {
    try {
         // Check if directory exists first
         if (!fse.existsSync(directory)) {
             // console.warn(`Directory not found for reading pattern ${baseNamePattern}: ${directory}`);
             return { content: `Directory not found: ${path.basename(directory)}`, found: false, fileName: null };
         }
        const files = await fs.readdir(directory);
        // Find the first file matching the base pattern (e.g., daily_digest_...)
        const fileName = files.find(file => file.startsWith(baseNamePattern) && file.endsWith('.md'));
        if (fileName) {
            const filePath = path.join(directory, fileName);
            console.log(`   Reading file: ${filePath}`); // Log which file is being read
            const markdownContent = await fs.readFile(filePath, 'utf8');
            const htmlContent = marked.parse(markdownContent); // Convert Markdown to HTML
            return { content: htmlContent, found: true, fileName: fileName };
        }
        // console.warn(`No file found matching pattern "${baseNamePattern}*.md" in ${directory}`);
        return { content: `File starting with "${baseNamePattern}" not found.`, found: false, fileName: null };
    } catch (error) {
        console.error(`Error reading file matching ${baseNamePattern} in ${directory}:`, error);
        return { content: `Error reading analysis file. Check server logs.`, found: false, fileName: null };
    }
}

// --- Routes ---

// Root route: Show latest date's combined analysis
app.get('/', async (req, res) => {
    const availableDates = await getAvailableDates();
    if (availableDates.length === 0) {
        return res.render('index', {
            currentDate: null,
            availableDates: [],
            sources: [],
            digest: { content: 'No data available yet. Run the main.js script first.', found: false },
            essay: { content: '', found: false },
            error: 'No analysis data found.'
        });
    }
    const latestDate = availableDates[0];
    res.redirect(`/${latestDate}`); // Redirect to the latest date page
});

// Date-specific route: Show combined analysis for a given date
app.get('/:date', async (req, res, next) => {
    const requestedDate = req.params.date;
    // Validate date format
    if (!dayjs(requestedDate, 'YYYY-MM-DD', true).isValid()) {
        return res.status(400).send('Invalid date format. Use YYYY-MM-DD.');
    }

    const datePath = path.join(DATA_DIR, requestedDate);
    if (!fse.existsSync(datePath)) {
         console.warn(`Date directory not found: ${datePath}`);
         // Send to a 404 or redirect to root if the date itself doesn't exist
         // Find the latest date again to redirect safely
         const availableDates = await getAvailableDates();
         if (availableDates.length > 0) {
            return res.redirect(`/${availableDates[0]}`);
         } else {
             // No dates exist at all
             return res.render('index', {
                 currentDate: null, availableDates: [], sources: [],
                 digest: { content: 'No analysis data found for the requested date or any date.', found: false },
                 essay: { content: '', found: false },
                 error: `No data found for ${requestedDate}.`
             });
         }
    }

    const availableDates = await getAvailableDates();
    const sources = await getSourcesForDate(requestedDate); // Sources within *this* date

    // Find COMBINED files directly in the date folder
    const digestResult = await findAndReadMarkdown(datePath, 'daily_digest_');
    const essayResult = await findAndReadMarkdown(datePath, 'analysis_essay_');

    res.render('index', {
        currentDate: requestedDate,
        availableDates: availableDates,
        sources: sources, // List sources for this date
        digest: digestResult,
        essay: essayResult,
        error: null
    });
});

// Display source-specific analysis for a date and source
app.get('/:date/:source', async (req, res) => {
    const requestedDate = req.params.date;
    const requestedSource = req.params.source;

    if (!dayjs(requestedDate, 'YYYY-MM-DD', true).isValid()) {
        return res.status(400).send('Invalid date format.');
    }

    const availableDates = await getAvailableDates(); // For navigation dropdown
    const allSourcesForDate = await getSourcesForDate(requestedDate); // *** Get all sources for this date ***
    const sourcePath = path.join(DATA_DIR, requestedDate, requestedSource); // Path to source dir

     // Check if the source directory exists for that date
     if (!fse.existsSync(sourcePath)) {
        return res.status(404).send(`Source '${requestedSource}' not found for date ${requestedDate}. <a href="/${requestedDate}">Back to ${requestedDate}</a>`);
     }

    // Find SOURCE-SPECIFIC files within the source folder
    const digestResult = await findAndReadMarkdown(sourcePath, `digest_${requestedSource}_`);
    const essayResult = await findAndReadMarkdown(sourcePath, `essay_${requestedSource}_`);

    res.render('source_detail', {
        currentDate: requestedDate,
        currentSource: requestedSource,
        availableDates: availableDates,
        allSourcesForDate: allSourcesForDate, // *** Pass this list to the template ***
        digest: digestResult,
        essay: essayResult,
        error: null
    });
});


// --- Start Server ---
app.listen(port, () => {
    console.log(`📰 News Analysis Viewer listening at http://localhost:${port}`);
    console.log(`   Serving data from: ${DATA_DIR}`);
});
