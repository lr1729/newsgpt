// scraper.js
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs').promises;
const path = require('path');
const { config } = require('./config');

puppeteer.use(StealthPlugin());

// Keep findTargetPage as it was
async function findTargetPage(browser, targetUrl) {
    const pages = await browser.pages();
    let targetOrigin;
     try { targetOrigin = new URL(targetUrl).origin; } catch (e) { console.error(`   Invalid target URL format: ${targetUrl}`); return null; }
    console.log(`   Searching for target tab matching origin: ${targetOrigin} (${pages.length} open)`);
    for (let i = pages.length - 1; i >= 0; i--) {
        const p = pages[i];
        try {
            const pageUrl = p.url();
            const pageOrigin = new URL(pageUrl).origin;
             // console.log(`   Checking page: ${pageUrl}`); // Uncomment for verbose debugging
            if (pageOrigin === targetOrigin || pageUrl === targetUrl) {
                const pageTitle = await p.title();
                 // console.log(`   Found potential match: ${pageUrl} (Title: ${pageTitle})`); // Uncomment for verbose debugging
                if (!/options|settings|extensions/i.test(pageTitle) && !pageUrl.startsWith('chrome-extension://')) {
                     console.log(`   🎯 Target tab identified: ${pageUrl}`); await p.bringToFront(); return p;
                } else { console.log(`   Skipping likely extension page: ${pageTitle}`); }
            }
        } catch (error) { if (!error.message.includes('Target closed')) { console.warn(`   Warning: Could not check page: ${error.message}`); } }
    }
    // Fallback logic as before...
    if (pages.length > 0) {
         try {
             const initialPage = pages[0];
             const initialPageUrl = initialPage.url();
             const initialPageOrigin = new URL(initialPageUrl).origin;
             if (initialPageOrigin === targetOrigin && !initialPageUrl.startsWith('chrome-extension://')) {
                 console.warn(`   ⚠️ Could not reliably identify target page. Falling back to initial page: ${initialPageUrl}`);
                 await initialPage.bringToFront();
                 return initialPage;
             }
         } catch (error) {
              console.warn(`   Warning: Could not evaluate fallback initial page: ${error.message}`);
         }
     }
    console.error(`   ❌ Could not find a suitable target page for ${targetUrl}.`);
    return null;
}


/**
 * Core scraping logic: Launches browser, navigates, finds target page, and scrolls for a duration.
 * @param {string} url - URL to scrape
 * @returns {Promise<{browser: *, page: *}|null>} Browser and Page object or null on error
 */
async function launchAndNavigate(url) {
    const bypassPaywallsPath = config.scraper.bypassPaywallsExtensionPath;
    const ublockLitePath = config.scraper.ublockLiteExtensionPath;
    let browser;

    const extensionPaths = [bypassPaywallsPath, ublockLitePath].filter(p => p);
    if (extensionPaths.length === 0) { console.error('❌ No valid extension paths.'); return null; }
    for (const extPath of extensionPaths) { try { await fs.access(extPath); } catch (err) { console.error(`❌ Extension path not found: ${extPath}`); return null; } }
    const loadExtensionArg = extensionPaths.join(',');
    const disableExceptArg = extensionPaths.join(',');

    try {
        browser = await puppeteer.launch({ headless: false, args: [ `--disable-extensions-except=${disableExceptArg}`, `--load-extension=${loadExtensionArg}`, '--no-sandbox', '--disable-setuid-sandbox', '--window-size=1366,768' ] });
        let initialPage = (await browser.pages())[0] || await browser.newPage();
        await initialPage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
        await initialPage.setViewport({ width: 1366, height: 768 });

        console.log(`   Navigating initial tab to: ${url}`);
        await initialPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });

        console.log(`   Waiting after navigation load event (3s)...`);
        await new Promise(resolve => setTimeout(resolve, 3000));

        const page = await findTargetPage(browser, url);
        if (!page) { console.error(`❌ Failed page find.`); await browser.close(); return null; }
        console.log(`   Working with page: ${page.url()}`);

        console.log(`   Waiting for rendering (1.5s)...`);
        await new Promise(resolve => setTimeout(resolve, 1500));

        // --- UPDATED TIME-BASED SCROLLING ---
        const scrollDuration = 4000; // Scroll for 4 seconds (adjust as needed, 3-5s range)
        const scrollInterval = 100; // Scroll every 100ms
        const scrollDistance = 150; // Pixels to scroll each interval

        console.log(`   Scrolling page for ${scrollDuration / 1000} seconds...`);
        try {
            await page.evaluate(async (duration, interval, distance) => {
                await new Promise((resolve) => {
                    let scrolled = 0;
                    const intervalId = setInterval(() => {
                        window.scrollBy(0, distance);
                        scrolled += interval;
                        if (scrolled >= duration) {
                            clearInterval(intervalId);
                            resolve();
                        }
                    }, interval);
                });
            }, scrollDuration, scrollInterval, scrollDistance); // Pass variables to evaluate
            console.log('   Scrolling finished.');
        } catch (scrollError) {
            console.warn(`   ⚠️ Warning during scrolling: ${scrollError.message}.`);
        }
        // --- END UPDATED SCROLLING ---

        console.log('   Waiting briefly after scroll (1s)...');
        await new Promise(resolve => setTimeout(resolve, 1000));

        return { browser, page };

    } catch (error) {
        console.error(`❌ Error during navigation/setup for ${url}: ${error.message}`);
        if (browser) { await browser.close().catch(e => console.error(`Error closing browser: ${e.message}`)); }
        return null;
    }
}

// --- scrapeAndSave and scrapeAndGetContent Functions ---
// (Keep these exactly the same as the previous version - they use launchAndNavigate)

/** Scrapes and SAVES */
async function scrapeAndSave(url, outputFilePath) {
    console.log(`🚀 Starting scrape & SAVE for: ${url}`);
    console.log(`   Saving raw HTML to: ${outputFilePath}`);
    let browser; let navigationResult = null;
    try {
        navigationResult = await launchAndNavigate(url);
        if (!navigationResult) return false;
        ({ browser, page } = navigationResult);
        console.log('   Capturing page content for saving...');
        const content = await page.content();
        await fs.mkdir(path.dirname(outputFilePath), { recursive: true });
        await fs.writeFile(outputFilePath, content, 'utf8');
        console.log(`✅ Successfully saved raw HTML: ${path.basename(outputFilePath)}`);
        return true;
    } catch (error) { console.error(`❌ Error scraping/saving ${url}: ${error.message}`); return false; }
    finally { if (navigationResult?.browser) { await navigationResult.browser.close().catch(e => console.error(`Err closing browser: ${e.message}`)); console.log(`   Browser closed for ${url}`); } }
}

/** Scrapes and RETURNS content */
async function scrapeAndGetContent(url) {
    console.log(`🚀 Starting scrape & GET CONTENT for: ${url}`);
    let browser; let navigationResult = null;
    try {
        navigationResult = await launchAndNavigate(url);
        if (!navigationResult) return null;
        ({ browser, page } = navigationResult);
        console.log('   Capturing page content for return...');
        const content = await page.content();
        console.log(`✅ Successfully captured content for: ${url}`);
        return content;
    } catch (error) { console.error(`❌ Error scraping/getting content for ${url}: ${error.message}`); return null; }
    finally { if (navigationResult?.browser) { await navigationResult.browser.close().catch(e => console.error(`Err closing browser: ${e.message}`)); console.log(`   Browser closed for ${url}`); } }
}


module.exports = {
    scrapeAndSave,
    scrapeAndGetContent
};
