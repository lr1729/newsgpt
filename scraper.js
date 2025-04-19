// scraper.js
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs').promises;
const path = require('path');
const { config } = require('./config');

puppeteer.use(StealthPlugin());

/**
 * Finds the correct page object for the target URL after navigation/potential redirects.
 * @param {import('puppeteer').Browser} browser - The Puppeteer browser instance.
 * @param {string} targetUrl - The URL we are trying to load.
 * @returns {Promise<import('puppeteer').Page|null>} - The Page object or null if not found.
 */
async function findTargetPage(browser, targetUrl) {
    const pages = await browser.pages();
    const targetOrigin = new URL(targetUrl).origin; // e.g., https://www.nytimes.com

    console.log(`   Searching for target tab matching origin: ${targetOrigin}`);
    console.log(`   Currently open pages: ${pages.length}`);

    for (const p of pages) {
        try {
            const pageUrl = p.url();
             console.log(`   Checking page: ${pageUrl}`);
            // Check if the page URL starts with the target origin or the original target URL
            if (pageUrl.startsWith(targetOrigin) || pageUrl === targetUrl) {
                // Additional check to ensure it's not the extension's options page etc.
                const pageTitle = await p.title();
                 console.log(`   Found potential match: ${pageUrl} (Title: ${pageTitle})`);
                if (!pageTitle.toLowerCase().includes('bypass paywalls clean')) { // Avoid extension page
                     console.log(`   🎯 Target tab identified: ${pageUrl}`);
                     // Bring the target page to the front (useful for non-headless)
                     await p.bringToFront();
                     return p;
                } else {
                    console.log(`   Skipping extension page: ${pageTitle}`);
                }
            }
        } catch (error) {
            // Ignore errors from pages that might have closed or are inaccessible
            console.warn(`   Warning: Could not get URL/Title for a page: ${error.message}`);
        }
    }

    console.warn(`   ⚠️ Could not reliably identify the target page for ${targetUrl}. Using the last opened page as fallback.`);
    // Fallback: Return the most recently opened page, hoping it's the right one
    return pages.length > 0 ? pages[pages.length - 1] : null;
}


/**
 * Scrape a webpage with stealth Puppeteer and bypass paywall using extension.
 * Saves the raw HTML content.
 * @param {string} url - URL to scrape
 * @param {string} outputFilePath - Full path where the HTML file should be saved
 * @returns {Promise<boolean>} - True if scraping and saving were successful, false otherwise
 */
async function scrapeAndSave(url, outputFilePath) {
    const extensionPath = config.scraper.extensionPath;
    let browser;

    console.log(`🚀 Starting scrape for: ${url}`);
    console.log(`   Using extension: ${extensionPath}`);
    console.log(`   Saving raw HTML to: ${outputFilePath}`);

    try {
        try {
            await fs.access(extensionPath);
        } catch (err) {
             console.error(`❌ Error: Extension path not found or inaccessible: ${extensionPath}`);
             console.error(`   Please verify the EXTENSION_PATH in your .env file or config.js`);
             return false;
        }

        browser = await puppeteer.launch({
            headless: false,
            args: [
                `--disable-extensions-except=${extensionPath}`,
                `--load-extension=${extensionPath}`,
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--window-size=1366,768'
            ]
        });

        // Start with the initial blank page
        const initialPage = (await browser.pages())[0];
        await initialPage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
        await initialPage.setViewport({ width: 1366, height: 768 });

        console.log(`   Navigating initial tab to: ${url}`);
        await initialPage.goto(url, { waitUntil: 'networkidle2', timeout: 90000 });

        console.log(`   Waiting after navigation for potential redirects/extension actions...`);
        await new Promise(resolve => setTimeout(resolve, 10000)); // Slightly shorter wait now

        // --- Find the correct tab ---
        const page = await findTargetPage(browser, url); // Use the helper function

        if (!page) {
            console.error(`❌ Failed to find the target browser page for ${url}. Aborting scrape for this URL.`);
            return false; // Indicate failure
        }
         console.log(`   Working with page: ${page.url()}`); // Confirm which page we're using


        // Wait a bit more for content rendering on the *correct* page
        console.log(`   Waiting for content rendering on target tab...`);
        await new Promise(resolve => setTimeout(resolve, 5000));


        // Scroll down on the *correct* page
        console.log('   Scrolling page...');
         try {
            await page.evaluate(async () => {
                 await new Promise((resolve) => {
                    let totalHeight = 0;
                    const distance = 150; // Slightly larger scroll distance
                    const maxScrolls = 100; // Limit scrolls to prevent infinite loops on weird pages
                    let scrolls = 0;
                    const timer = setInterval(() => {
                        const scrollHeight = document.body.scrollHeight;
                        window.scrollBy(0, distance);
                        totalHeight += distance;
                        scrolls++;

                        // Stop if we reach the bottom or hit the scroll limit
                        if (scrolls >= maxScrolls || totalHeight >= scrollHeight - window.innerHeight) {
                            clearInterval(timer);
                             console.log(`Scroll finished: ${scrolls} scrolls, totalHeight ${totalHeight}, scrollHeight ${scrollHeight}`);
                            resolve();
                        }
                    }, 150); // Scroll interval
                });
            });
             console.log('   Scrolling evaluation finished.');
        } catch (scrollError) {
             console.warn(`   ⚠️ Warning during scrolling: ${scrollError.message}. Proceeding anyway.`);
        }

        console.log('   Waiting after scroll...');
        await new Promise(resolve => setTimeout(resolve, 3000));

        console.log('   Capturing page content...');
        const content = await page.content();

        await fs.mkdir(path.dirname(outputFilePath), { recursive: true });
        await fs.writeFile(outputFilePath, content, 'utf8');

        console.log(`✅ Successfully saved raw HTML: ${path.basename(outputFilePath)}`);
        return true;

    } catch (error) {
        console.error(`❌ Error scraping ${url}: ${error.message}`);
        // console.error(error.stack); // Uncomment for detailed stack trace
        return false;
    } finally {
        if (browser) {
            try {
                await browser.close();
                console.log(`   Browser closed for ${url}`);
            } catch (closeError) {
                console.error(`   Error closing browser for ${url}: ${closeError.message}`);
            }
        }
    }
}

module.exports = { scrapeAndSave };
