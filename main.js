// main.js
const fs = require('fs').promises;
const path = require('path');
const { config, validateConfig } = require('./config');
const { ask_cerebras } = require('./cerebras-module');
const { ask_gemini } = require('./gemini-module');
const { scrapeAndSave } = require('./scraper'); // Your Puppeteer scraper
const fetch = require('node-fetch');

// --- Helper Functions --- (Keep getCurrentDateFolder, setupDirectories, readSourceUrls, urlToFilename as before)

/** Gets current date as YYYY-MM-DD */
function getCurrentDateFolder() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Creates directories and returns paths */
async function setupDirectories(dateFolder, sourceName) {
  const baseDir = config.scraper.outputBaseDir;
  const runDir = path.join(baseDir, dateFolder, sourceName); // Add source name
  const rawHtmlDir = path.join(runDir, 'raw_html');
  const parsedTextDir = path.join(runDir, 'parsed_text');

  await fs.mkdir(rawHtmlDir, { recursive: true }); // Creates runDir and sourceName dir too
  await fs.mkdir(parsedTextDir, { recursive: true });

  console.log(`🗂️ Output directories for ${sourceName} (${dateFolder}):`);
  console.log(`   - Raw HTML: ${rawHtmlDir}`);
  console.log(`   - Parsed Text: ${parsedTextDir}`);

  return { runDir, rawHtmlDir, parsedTextDir };
}

/** Reads URLs from the source list file */
async function readSourceUrls() {
    try {
        const data = await fs.readFile(config.sourceListFile, 'utf8');
        return data.split(/[\r\n]+/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
    } catch (error) {
        console.error(`❌ Error reading source URL file (${config.sourceListFile}): ${error.message}`);
        return [];
    }
}

/** Fetches initial HTML content from a URL */
async function fetchInitialHtml(url) {
    try {
        console.log(`🌐 Fetching initial HTML source from: ${url}`);
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`HTTP error ${response.status} fetching ${url}`);
        }
        return await response.text();
    } catch (error) {
        console.error(`❌ Error fetching initial HTML from ${url}: ${error.message}`);
        return null;
    }
}

/** Creates a filesystem-safe filename from a URL */
function urlToFilename(url, extension = '.html') {
    try {
        const parsedUrl = new URL(url);
        let filename = parsedUrl.pathname;
        filename = filename.replace(/^\/+|\/+$/g, '').replace(/\//g, '_');
        filename = filename.replace(/\.html$/i, '');
        filename = filename.replace(/[^a-zA-Z0-9_\-\.]/g, '_');
        filename = filename.substring(0, 100); // Keep truncation
        // Prevent filenames starting with _ if path was just "/"
        if (filename.startsWith('_') && filename.length > 1) {
            filename = filename.substring(1);
        }
        if (!filename) { // Handle case where path was just "/" or invalid chars
            filename = `index_${parsedUrl.hostname.replace(/[^a-zA-Z0-9]/g, '_')}`;
        }
        return filename + extension;
    } catch (e) {
        return `invalid_url_${Date.now()}${extension}`;
    }
}


/** Extracts article URLs using Cerebras - UPDATED PROMPT */
async function extractArticleUrls(sourceHtml, sourceUrl) {
    // Increased length slightly for better context, adjust if needed
    const snippetLength = 20000;
    const prompt = `Analyze the following HTML source code from ${sourceUrl}. Your task is to extract *every single distinct* absolute URL that points to a primary news article published on www.nytimes.com.

CRITICAL RULES:
1. Output *only* the full, valid URLs, each on a new line.
2. Ensure every URL starts with 'https://www.nytimes.com/'.
3. The URL path should generally contain a date (e.g., '/YYYY/MM/DD/') and end with '.html'. Prioritize these.
4. Identify URLs associated with main headlines, article teasers, and story links within the body of the email/page.
5. **EXCLUDE ALL** of the following types of URLs:
    - Section homepages (e.g., /section/world, /section/politics)
    - Author pages (/by/)
    - Interactive content (/interactive/)
    - Video or slideshow pages (/video/, /slideshow/)
    - Live blogs or updates (/live/)
    - Subscription or account management links (/subscription, /account, /mem/email.html)
    - Advertising links (check domains like nyt.com/adx, doubleclick.net, liveintent.com, etc., *even if within an 'a' tag*)
    - Help pages, contact us, privacy policy, terms of service, app download links.
    - Social media links (facebook.com, twitter.com, etc.)
    - "View in browser" or unsubscribe links.
    - Image source URLs (src attributes of img tags).
    - Links pointing to nytimes.com itself but not to specific articles (e.g., just https://www.nytimes.com/).
    - Any URL containing '/paidpost/'.
    - Any URL clearly related to managing newsletter preferences.
    - URLs with '/svc/messaging/' in the path.

List only the final, cleaned article URLs. Do not include duplicates.

HTML Content Snippet (first ${snippetLength} chars):
\`\`\`html
${sourceHtml.substring(0, snippetLength)}
\`\`\`
Extracted Article URLs:`;

    console.log("🧠 Asking Cerebras to extract ALL relevant article URLs...");
    try {
        const response = await ask_cerebras(prompt, { maxTokens: 2048 }); // Generous token limit for potentially many URLs
        if (!response) {
            console.error("❌ Cerebras returned no response for URL extraction.");
            return [];
        }
        const urls = response
            .split(/[\r\n]+/) // Split by newline, handle different line endings
            .map(line => {
                // Attempt to clean potential markdown or extra characters
                let cleanedLine = line.trim().replace(/^[-*]\s*/, ''); // Remove list markers
                try {
                    // Validate and remove query/fragment
                    const urlObj = new URL(cleanedLine);
                    return `${urlObj.origin}${urlObj.pathname}`;
                } catch {
                    return null; // Invalid URL format
                }
            })
            .filter(url =>
                url && // Check if URL is valid after parsing
                url.startsWith('https://www.nytimes.com/') &&
                url.endsWith('.html') &&
                !url.includes('/section/') &&
                !url.includes('/by/') &&
                !url.includes('/interactive/') &&
                !url.includes('/video/') &&
                !url.includes('/slideshow/') &&
                !url.includes('/live/') &&
                !url.includes('/svc/messaging') &&
                !url.includes('/subscription') &&
                !url.includes('/account') &&
                !url.includes('mem/email.html') &&
                !url.includes('/paidpost/') &&
                 /\/(\d{4})\/(\d{2})\/(\d{2})\//.test(url) // Re-emphasize date pattern preference
            );
        const uniqueUrls = [...new Set(urls)]; // Remove duplicates
        console.log(`📰 Extracted ${uniqueUrls.length} unique potential article URLs.`);
        if (uniqueUrls.length < 5 && sourceUrl.includes('nytimes.com/email-content')) {
             console.warn(`   ⚠️ Warning: Extracted fewer than 5 URLs from NYT email sample. Extraction might be incomplete.`);
        }
        // console.log('   Extracted URLs:', uniqueUrls); // Uncomment for debugging
        return uniqueUrls;
    } catch (error) {
        console.error(`❌ Error during URL extraction with Cerebras: ${error.message}`);
        return [];
    }
}

/** Extracts text content using Cerebras - UPDATED PROMPT FOR VERBATIM */
async function extractTextFromHtml(rawHtmlFilePath, parsedTextFilePath) {
    console.log(`📄 Reading raw HTML for text extraction: ${path.basename(rawHtmlFilePath)}`);
    try {
        const rawHtml = await fs.readFile(rawHtmlFilePath, 'utf8');
        // Limit input size to manage API costs/limits if necessary, but try to send a good chunk
        const snippetLength = 30000; // Send more HTML for better context
        const prompt = `Your task is to extract the *complete and verbatim textual content* of the main news article body from the following HTML source code. Reproduce the text exactly as it appears in the article's primary paragraphs.

CRITICAL INSTRUCTIONS:
1.  **Output ONLY the plain text** of the article's core narrative content.
2.  **DO NOT SUMMARIZE, PARAPHRASE, REPHRASE, or CHANGE** any of the original article wording.
3.  **Extract the FULL text** of the main article body, including all paragraphs belonging to the story.
4.  **Strictly EXCLUDE ALL** of the following elements:
    *   HTML tags (e.g., <p>, <div>, <a>, <img>, <script>, <style>).
    *   Headlines, titles, subheadings.
    *   Author names, bylines, affiliations, publication dates, timestamps.
    *   Website navigation menus (header, footer, sidebars).
    *   Advertisements, "suggested content," "related articles," "read more" links/sections.
    *   Image captions, photo credits, figure descriptions, video player text/controls.
    *   Comment sections and associated metadata.
    *   Social media sharing buttons/links.
    *   Subscription prompts or paywall messages.
    *   Lists of contents or jump links.
    *   Legal notices, copyright statements, terms of service, privacy policy links.
    *   Any non-prose elements like tables unless they are integral to the narrative flow (rare).
5.  Format the output as clean paragraphs separated by double newlines (\n\n). Preserve the original paragraph breaks from the article body.

HTML Content Snippet (first ${snippetLength} chars):
\`\`\`html
${rawHtml.substring(0, snippetLength)}
\`\`\`
Verbatim Extracted Article Text:`;

        console.log(`🧠 Asking Cerebras for *verbatim* text extraction: ${path.basename(rawHtmlFilePath)}`);
        // Increase maxTokens significantly for full article text
        const extractedText = await ask_cerebras(prompt, { maxTokens: 4096 });

        if (!extractedText || extractedText.trim().length < 150) { // Slightly higher threshold for verbatim
            console.warn(`⚠️ Cerebras returned insufficient verbatim text for ${path.basename(rawHtmlFilePath)}. Skipping.`);
            return null;
        }
        const cleanedText = extractedText.trim();
        await fs.writeFile(parsedTextFilePath, cleanedText, 'utf8');
        console.log(`✅ Verbatim text extracted & saved: ${path.basename(parsedTextFilePath)}`);
        return cleanedText;
    } catch (error) {
        console.error(`❌ Error extracting verbatim text from ${path.basename(rawHtmlFilePath)}: ${error.message}`);
        return null;
    }
}

/** Generates newsletter using Gemini - UPDATED PROMPT */
async function generateNewsletter(articlesData, outputPath) {
    console.log(`\n💡 Aggregating content from ${articlesData.length} articles for Gemini newsletter...`);

    let combinedContent = "Analyze the following news articles provided below, identified by their headlines and content, to generate a comprehensive daily news digest.\n\n";
    let currentLength = combinedContent.length;
    let includedCount = 0;

    for (const article of articlesData) {
        let headline = `Article from ${article.url}`; // Default
        try {
            const rawHtml = await fs.readFile(article.rawHtmlPath, 'utf8');
             // Use cheerio for more reliable title extraction
             const $ = require('cheerio').load(rawHtml);
             let potentialTitle = $('head title').first().text();

            if (potentialTitle) {
                 // Improved title cleaning
                 potentialTitle = potentialTitle
                     .replace(/\| The New York Times$/i, '')
                     .replace(/ - The New York Times$/i, '')
                     .replace(/ - NYTimes.com$/i, '')
                     .replace(/ \| NYT$/i, '')
                     .replace(/ - NYT$/i, '')
                     .replace(/^The New York Times: /i, '')
                     .replace(/New York Times/, '') // Consider case-insensitive replace if needed
                     .replace(/The New York Times/, '')
                     .trim();
                 // Avoid using generic titles
                 if (potentialTitle && !potentialTitle.toLowerCase().includes('headlines') && potentialTitle.length > 10) {
                    headline = potentialTitle;
                 } else {
                     // Fallback: Try to get the first H1 if title is bad
                     const h1Text = $('h1').first().text().trim();
                     if (h1Text && h1Text.length > 10) {
                         headline = h1Text;
                     }
                 }
            }
        } catch (e) { console.warn(`   Could not read/parse raw HTML for headline: ${path.basename(article.rawHtmlPath)}`); }

        // Ensure text is not null or undefined before calculating length
        const articleTextContent = article.text || '';
        const articleEntry = `--- ARTICLE START ---\nHeadline: ${headline}\nURL: ${article.url}\n\nContent:\n${articleTextContent}\n--- ARTICLE END ---\n\n`;
        const entryLength = articleEntry.length;

        if (currentLength + entryLength <= config.maxArticleContentLengthForGemini) {
            combinedContent += articleEntry;
            currentLength += entryLength;
            includedCount++;
        } else {
            console.warn(`   ⚠️ Truncating input for Gemini. Skipping article: ${headline.substring(0,50)}... due to length limits.`);
            // Optionally add just the headline if space allows
             const headlineEntry = `--- ARTICLE START ---\nHeadline: ${headline}\nURL: ${article.url}\n\nContent: [Content truncated due to length limits]\n--- ARTICLE END ---\n\n`;
             if (currentLength + headlineEntry.length <= config.maxArticleContentLengthForGemini) {
                combinedContent += headlineEntry;
                currentLength += headlineEntry.length;
             }
        }
    }

    if (includedCount === 0) {
        console.error("❌ No article content could be included for Gemini analysis.");
        return;
    }

    console.log(`   Aggregated content from ${includedCount} articles (${currentLength} chars) for Gemini.`);

    // Refined Gemini Prompt
    const prompt = `Act as a neutral, objective news analyst. Synthesize the provided collection of news articles (separated by '--- ARTICLE START ---' and '--- ARTICLE END ---', including their headlines and verbatim content) into a comprehensive daily newsletter digest.

**Newsletter Structure and Content Requirements:**

1.  **Overall Summary (Required):**
    *   Start with a concise (2-4 sentences) and strictly objective overview of the most significant events reported across *all* the provided articles. Do not add information not present in the texts.

2.  **Key Story Summaries (Required):**
    *   Identify the main news stories presented.
    *   Group related stories under thematic headings (e.g., ## Politics, ## World News, ## Business, ## Technology, ## Arts & Culture, ## Local News). Use judgment to create relevant categories based on the articles.
    *   For each story, provide a brief, factual summary (3-6 sentences) based *only* on the provided text. Use the corresponding headline provided for each article.

3.  **Key Facts (Required):**
    *   Under a heading ## Key Facts Reported, list 3-5 distinct, verifiable facts presented in the articles using bullet points. Cite the source headline briefly in parentheses if helpful (e.g., "- Fact statement (Headline: ...)")

4.  **Narrative Analysis (Required):**
    *   Under a heading ## Narrative Analysis, briefly (2-4 sentences) and neutrally discuss any recurring themes, dominant perspectives, potential biases, or differing angles observed *across* the provided articles. Focus on *how* the news is presented, not your opinion of it. For example: "Reporting on X focused heavily on Y, while coverage of Z highlighted Q." or "Multiple articles address the theme of Y, presenting differing viewpoints on its cause."

5.  **Analyst's Note (Optional, Max 1):**
    *   If there is a particularly complex or significant story, you *may* add *one* short (1-2 sentences) section labeled ## Analyst's Note.
    *   This note should provide brief, neutral context or potential implications derived *logically* from the reported facts.
    *   **Crucially, DO NOT express personal opinions, make predictions, or introduce external information not found in the provided texts.** If unsure, omit this section.

**Input Articles:**
${combinedContent}`;


    console.log("🤖 Asking Gemini to generate the daily newsletter...");
    try {
        const newsletterContent = await ask_gemini(prompt, {
            temperature: config.gemini.temperature
        });
        if (!newsletterContent) {
            console.error("❌ Gemini returned no response for newsletter generation.");
            return;
        }

        // Basic cleanup of potential Gemini artifacts if needed
        const cleanedNewsletter = newsletterContent.replace(/```markdown\n?/, '').replace(/```$/, '').trim();

        await fs.writeFile(outputPath, cleanedNewsletter, 'utf8');
        console.log(`✅📰 Daily newsletter saved: ${path.basename(outputPath)}`);
    } catch (error) {
        console.error(`❌ Error during newsletter generation with Gemini: ${error.message}`);
        // console.error(error.stack); // Uncomment for detailed stack trace
    }
}


// --- Main Execution ---
async function main() {
  console.log("--- Starting Daily News Analysis Workflow ---");

  if (!validateConfig()) {
    process.exit(1);
  }

  const dateFolder = getCurrentDateFolder();
  const sourceUrlsFromFile = await readSourceUrls();
  const allArticlesData = []; // Collect data from all sources

  for (const sourceUrl of sourceUrlsFromFile) {
    console.log(`\nProcessing Source URL: ${sourceUrl}`);
    let sourceHtml;
    let sourceName = 'unknown_source';

    try {
        const parsedSourceUrl = new URL(sourceUrl);
        const hostname = parsedSourceUrl.hostname;
        sourceName = config.sourceMapping[hostname] || hostname.replace(/^www\./, '').split('.')[0];
        console.log(`   Identified Source Name: ${sourceName}`);
    } catch (e) {
        console.error(`   Skipping invalid URL in urls.txt: ${sourceUrl}`);
        continue;
    }

    const { runDir, rawHtmlDir, parsedTextDir } = await setupDirectories(dateFolder, sourceName);

    // --- Step 1: Get Initial HTML & Extract Article URLs ---
    console.log("--- Step 1: Fetching Source & Extracting Article URLs ---");
    sourceHtml = await fetchInitialHtml(sourceUrl);
    if (!sourceHtml) {
        console.warn(`   Skipping source ${sourceName} due to fetch error.`);
        continue;
    }

    const articleUrls = await extractArticleUrls(sourceHtml, sourceUrl);
    if (articleUrls.length === 0) {
        console.log(`   No article URLs extracted for ${sourceName}.`);
        continue;
    }

    // --- Step 2: Scrape each article URL ---
    const scrapedArticlePaths = [];
    console.log(`\n--- Step 2: Scraping ${articleUrls.length} Articles for ${sourceName} ---`);
    let scrapeCounter = 0;
    for (const url of articleUrls) {
        scrapeCounter++;
        console.log(`   Scraping article ${scrapeCounter}/${articleUrls.length}: ${url}`);
        const rawHtmlFileName = urlToFilename(url, '.html');
        const rawHtmlFilePath = path.join(rawHtmlDir, rawHtmlFileName);

        const success = await scrapeAndSave(url, rawHtmlFilePath);
        if (success) {
            scrapedArticlePaths.push({ url, rawHtmlPath: rawHtmlFilePath });
        } else {
            console.warn(`   Failed to scrape: ${url}`);
        }
        if (scrapeCounter < articleUrls.length) {
            console.log(`   Waiting ${config.processingDelayMs / 1000}s before next scrape...`);
            await new Promise(resolve => setTimeout(resolve, config.processingDelayMs));
        }
    }

    if (scrapedArticlePaths.length === 0) {
      console.log(`🚫 No articles successfully scraped for ${sourceName}.`);
      continue;
    }

    // --- Step 3: Extract text from scraped HTML ---
    console.log(`\n--- Step 3: Extracting Text from ${scrapedArticlePaths.length} Scraped Articles (${sourceName}) ---`);
    let extractionCounter = 0;
    for (const article of scrapedArticlePaths) {
        extractionCounter++;
        console.log(`   Extracting text ${extractionCounter}/${scrapedArticlePaths.length}: ${path.basename(article.rawHtmlPath)}`);
        const baseName = path.basename(article.rawHtmlPath, '.html');
        const parsedTextFilePath = path.join(parsedTextDir, `${baseName}.txt`);

        const extractedText = await extractTextFromHtml(article.rawHtmlPath, parsedTextFilePath);
        if (extractedText) {
            allArticlesData.push({ // Add to the global list
                url: article.url,
                text: extractedText,
                rawHtmlPath: article.rawHtmlPath,
                source: sourceName // Add source info if needed later
            });
        }
        // Shorter delay for CPU-bound tasks potentially
        if (extractionCounter < scrapedArticlePaths.length) {
            console.log(`   Waiting ${config.processingDelayMs / 1000 / 2}s before next extraction...`);
             await new Promise(resolve => setTimeout(resolve, config.processingDelayMs / 2));
        }
    }
  } // End loop through source URLs

  // --- Step 4: Generate the final newsletter ---
  if (allArticlesData.length > 0) {
    console.log(`\n--- Step 4: Generating Final Newsletter from ${allArticlesData.length} Processed Articles ---`);
    const baseRunDir = path.join(config.scraper.outputBaseDir, dateFolder); // Use base date folder
    // Ensure base date directory exists if no sources were successfully processed to this point but we still want to note it
    await fs.mkdir(baseRunDir, { recursive: true });
    const newsletterFileName = `daily_newsletter_${dateFolder}.md`;
    const newsletterOutputPath = path.join(baseRunDir, newsletterFileName);
    await generateNewsletter(allArticlesData, newsletterOutputPath);
  } else {
    console.log("\n🚫 No articles processed successfully across all sources. Final newsletter not generated.");
  }

  console.log("\n--- Workflow Complete ---");
}

// Run the main function
main().catch(error => {
  console.error("💥 Unhandled error in main workflow:", error);
  process.exit(1);
});
