// scraper.js
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs').promises;
const path = require('path');
const { config } = require('./config');

puppeteer.use(StealthPlugin());

// --- Helper: Find Target Page (Keep as before) ---
async function findTargetPage(browser, targetUrl) {
    // ... (keep the existing findTargetPage function implementation)
    const pages = await browser.pages();
    const targetOrigin = new URL(targetUrl).origin;
    console.log(`   Searching for target tab matching origin: ${targetOrigin} (${pages.length} pages open)`);
    for (const p of pages) {
        try {
            const pageUrl = p.url();
            if (pageUrl.startsWith(targetOrigin) || pageUrl === targetUrl) {
                const pageTitle = await p.title();
                if (!/options|settings|extensions/i.test(pageTitle) && !pageUrl.startsWith('chrome-extension://')) {
                     console.log(`   🎯 Target tab identified: ${pageUrl}`);
                     await p.bringToFront();
                     return p;
                } else { console.log(`   Skipping likely extension page: ${pageTitle || pageUrl}`); }
            }
        } catch (error) { console.warn(`   Warning: Could not get URL/Title for a page: ${error.message}`); }
    }
    console.warn(`   ⚠️ Could not reliably identify the target page for ${targetUrl}. Using the last opened page as fallback.`);
    return pages.length > 0 ? pages[pages.length - 1] : null;
}


// --- NEW FUNCTION: Fetch Initial HTML using Puppeteer ---
/**
 * Fetches the initial HTML content of a source URL using Puppeteer (without extensions initially).
 * @param {string} url - The source URL to fetch (e.g., homepage, section page).
 * @returns {Promise<string|null>} - The HTML content or null on failure.
 */
async function fetchSourceHtmlWithPuppeteer(url) {
    let browser;
    console.log(`\n puppeteer: 🌐 Fetching initial source page HTML for URL extraction: ${url}`);
    try {
        // Launch a clean browser instance *without* extensions for this initial fetch
        // This is often less likely to trigger detection than loading extensions immediately
        browser = await puppeteer.launch({
            headless: true, // Headless is usually fine for initial fetch
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--window-size=1366,768' // Still good practice
            ]
        });
        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
        await page.setViewport({ width: 1366, height: 768 });

        console.log(`   Navigating to source page...`);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }); // domcontentloaded is often enough for initial structure

        console.log(`   Waiting briefly for initial scripts...`);
        await new Promise(resolve => setTimeout(resolve, 5000)); // Shorter wait might be okay

        console.log(`   Getting initial page content...`);
        const content = await page.content();
        console.log(`   ✅ Successfully fetched initial HTML for ${url}`);
        return content;

    } catch (error) {
        console.error(`❌ Error fetching initial HTML with Puppeteer for ${url}: ${error.message}`);
        return null;
    } finally {
        if (browser) {
            await browser.close();
            console.log(`   Browser closed for initial fetch of ${url}`);
        }
    }
}


// --- Function: Scrape and Save Article (Keep as before, using extensions) ---
/**
 * Scrape a specific article webpage with extensions loaded.
 * Saves the raw HTML content.
 * @param {string} url - URL to scrape
 * @param {string} outputFilePath - Full path where the HTML file should be saved
 * @returns {Promise<boolean>} - True if successful, false otherwise
 */
async function scrapeAndSave(url, outputFilePath) {
    const bypassPaywallsPath = config.scraper.bypassPaywallsExtensionPath;
    const ublockLitePath = config.scraper.ublockLiteExtensionPath;
    let browser;

    console.log(`🚀 Starting article scrape for: ${url}`);
    console.log(`   Using Bypass Paywalls: ${bypassPaywallsPath}`);
    console.log(`   Using uBlock Origin Lite: ${ublockLitePath}`);
    console.log(`   Saving raw HTML to: ${outputFilePath}`);

    const extensionPaths = [bypassPaywallsPath, ublockLitePath].filter(p => p);
    if (extensionPaths.length === 0) { console.error('❌ No valid extension paths.'); return false; }

    for (const extPath of extensionPaths) {
        try { await fs.access(extPath); } catch (err) { console.error(`❌ Extension path not found: ${extPath}`); return false; }
    }

    const loadExtensionArg = extensionPaths.join(',');
    const disableExceptArg = extensionPaths.join(',');

    try {
        browser = await puppeteer.launch({
            headless: false, // Keep false for debugging extensions
            args: [
                `--disable-extensions-except=${disableExceptArg}`,
                `--load-extension=${loadExtensionArg}`,
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--window-size=1366,768'
            ]
        });

        const initialPage = (await browser.pages())[0];
        await initialPage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
        await initialPage.setViewport({ width: 1366, height: 768 });

        console.log(`   Navigating initial tab to article: ${url}`);
        await initialPage.goto(url, { waitUntil: 'networkidle2', timeout: 90000 });

        console.log(`   Waiting after navigation for redirects/extensions...`);
        await new Promise(resolve => setTimeout(resolve, 10000));

        const page = await findTargetPage(browser, url);

        if (!page) {
            console.error(`❌ Failed to find target page for ${url}.`);
            const pages = await browser.pages();
            for(const p of pages){ if(p !== initialPage) await p.close().catch(e => console.warn(`   Warn: Failed to close extra page: ${e.message}`)); }
            return false;
        }
        console.log(`   Working with page: ${page.url()}`);

        console.log(`   Waiting for content rendering...`);
        await new Promise(resolve => setTimeout(resolve, 5000));

        console.log('   Scrolling page...');
        try {
            await page.evaluate(async () => { /* ... Keep scrolling logic ... */ });
            console.log('   Scrolling evaluation finished.');
        } catch (scrollError) { console.warn(`   ⚠️ Warning during scrolling: ${scrollError.message}.`); }

        console.log('   Waiting after scroll...');
        await new Promise(resolve => setTimeout(resolve, 3000));

        console.log('   Capturing page content...');
        const content = await page.content();
        await fs.mkdir(path.dirname(outputFilePath), { recursive: true });
        await fs.writeFile(outputFilePath, content, 'utf8');
        console.log(`✅ Successfully saved raw article HTML: ${path.basename(outputFilePath)}`);
        return true;

    } catch (error) {
        console.error(`❌ Error scraping article ${url}: ${error.message}`);
        return false;
    } finally {
        if (browser) {
            try { await browser.close(); console.log(`   Browser closed for article ${url}`); }
            catch (closeError) { console.error(`   Error closing browser for ${url}: ${closeError.message}`); }
        }
    }
}

// Export both functions now
module.exports = {
    scrapeAndSave,
    fetchSourceHtmlWithPuppeteer // Export the new function
};
