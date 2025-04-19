// main.js
const fs = require('fs').promises;
const path = require('path');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const { config, validateConfig } = require('./config');
const { ask_gemini } = require('./gemini-module');
const { scrapeAndSave } = require('./scraper');
const fetch = require('node-fetch');
const cheerio = require('cheerio');

// --- Helper Functions --- (getCurrentDateFolder, setupDirectories, readSourceUrls, fetchInitialHtml, urlToFilename remain the same)

function getCurrentDateFolder() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

async function setupDirectories(dateFolder, sourceName) {
    const baseDir = config.scraper.outputBaseDir;
    const runDir = path.join(baseDir, dateFolder, sourceName);
    const rawHtmlDir = path.join(runDir, 'raw_html');
    const parsedTextDir = path.join(runDir, 'parsed_text');
    await fs.mkdir(rawHtmlDir, { recursive: true });
    await fs.mkdir(parsedTextDir, { recursive: true });
    console.log(`🗂️ Output directories for ${sourceName} (${dateFolder}):`);
    console.log(`   - Raw HTML: ${rawHtmlDir}`);
    console.log(`   - Parsed Text: ${parsedTextDir}`);
    return { runDir, rawHtmlDir, parsedTextDir };
}

async function readSourceUrls() {
    try {
        const data = await fs.readFile(config.sourceListFile, 'utf8');
        return data.split(/[\r\n]+/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
    } catch (error) {
        console.error(`❌ Error reading source URL file (${config.sourceListFile}): ${error.message}`);
        return [];
    }
}

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

function urlToFilename(url, extension = '.html') {
    try {
        const parsedUrl = new URL(url);
        let filename = parsedUrl.hostname + parsedUrl.pathname + (parsedUrl.search || '');
        filename = filename.replace(/^\/+|\/+$/g, '').replace(/[\/\\]/g, '_');
        filename = filename.replace(/[:*?"<>|]/g, '_');
        filename = filename.replace(/\.html$/i, '');
        filename = filename.substring(0, 180);
        if (filename.startsWith('_') && filename.length > 1) filename = filename.substring(1);
        if (!filename) filename = `index_${parsedUrl.hostname.replace(/[^a-zA-Z0-9]/g, '_')}`;
        return filename + extension;
    } catch (e) {
        return `invalid_url_${Date.now()}${extension}`;
    }
}


/** Extracts likely article URLs using Gemini */
async function extractArticleUrls(sourceHtml, sourceUrl) {
    let targetDomain = 'unknown';
     try { targetDomain = new URL(sourceUrl).hostname; } catch {}
    const prompt = `Analyze the following HTML source code from ${sourceUrl}. Extract *every single distinct* absolute URL that appears to be a link to a primary news article hosted on the domain '${targetDomain}' or its direct subdomains (like www.${targetDomain.replace(/^static\./,'')}).

CRITICAL RULES:
1. Output *ONLY* the full, valid URLs, each on a new line. NO extra text.
2. URLs *MUST* start with 'http://' or 'https://' and target the specified domain or its 'www.' subdomain.
3. Prioritize URLs linked from headlines, article summaries, or prominent story links.
4. The URL path should look like it leads to specific content (e.g., contain multiple segments, end in .html, or include date patterns YYYY/MM/DD).
5. **Strictly EXCLUDE ALL** URLs matching these patterns or types: section/category pages, author/tag pages, ads, trackers, login/subscription links, site navigation (header/footer), help/contact/policy pages, social media, multimedia galleries, email actions, file downloads, paid content sections, archive pages (unless linking to specific articles), /svc/messaging/, etc.

List only the valid, full article URLs, one per line. Preserve the original URL structure including query parameters.

HTML Content:
\`\`\`html
${sourceHtml}
\`\`\`
Extracted Article URLs:`;

    console.log(`🧠 Asking Gemini to extract URLs from ${sourceUrl} (Temp: 0.1)...`);
    try {
        const response = await ask_gemini(prompt, { temperature: 0.1 });
        if (!response) { console.error("❌ Gemini returned no response for URL extraction."); return []; }
        const urls = response
            .split(/[\r\n]+/)
            .map(line => line.trim().replace(/^[-*]\s*/, ''))
            .filter(line => {
                if (!line.startsWith('http')) return false;
                try {
                    const parsed = new URL(line);
                    const lineHostname = parsed.hostname;
                    const baseTargetDomain = targetDomain.replace(/^www\.|^static\./g, '');
                    const lineBaseDomain = lineHostname.replace(/^www\./g, '');
                    const isTargetDomain = lineHostname === targetDomain || lineBaseDomain === baseTargetDomain || `www.${lineBaseDomain}` === targetDomain;
                    const path = parsed.pathname;
                    const isLikelyArticlePath = path.length > 1 && !path.endsWith('/') && (path.includes('.html') || path.split('/').length > 2);
                    const isExcludedPath = /^\/(section|category|politics|business|technology|arts|opinion|world|us|nyregion|food|well|travel|realestate|fashion|obituaries|by|author|tag|topic|interactive|video|slideshow|live|gallery|audio|paidpost|sponsor-content|svc\/messaging|login|account|subscribe|subscription|register|help|contact|about|privacy|terms|rss|apps)\b/i.test(path) || /\.(jpg|png|gif|css|js|pdf|xml|ico)$/i.test(path) || path.includes('mem/email.html') || path.includes('/adx/');
                    const isAdParam = /[?&](utm_|ad|cid|trk|campaign|promo|src)=/i.test(parsed.search);
                    return isTargetDomain && isLikelyArticlePath && !isExcludedPath && !isAdParam;
                } catch { return false; }
            });
        const uniqueUrls = [...new Set(urls)];
        console.log(`📰 Extracted ${uniqueUrls.length} unique potential article URLs for ${targetDomain}.`);
        if (uniqueUrls.length > 0) {
            console.log("--- Extracted URLs ---");
            uniqueUrls.forEach(url => console.log(url));
            console.log("----------------------");
        } else {
            console.log("   (Gemini did not return any valid-looking URLs after filtering)");
        }
        return uniqueUrls;
    } catch (error) {
        console.error(`❌ Error during URL extraction with Gemini: ${error.message}`);
        return [];
    }
}


/** Extracts verbatim text content using Gemini */
async function extractTextFromHtml(rawHtmlFilePath, parsedTextFilePath) {
    console.log(`📄 Reading raw HTML for text extraction: ${path.basename(rawHtmlFilePath)}`);
    try {
        const rawHtml = await fs.readFile(rawHtmlFilePath, 'utf8');
        const prompt = `Your primary goal is to extract the *complete and verbatim textual content* of the main news article body from the following HTML source code. Reproduce the text exactly as it appears in the article's primary paragraphs.

CRITICAL INSTRUCTIONS:
1.  **Output ONLY the plain text** of the article's core narrative content.
2.  **DO NOT SUMMARIZE, PARAPHRASE, REPHRASE, or CHANGE** any of the original article wording.
3.  **Extract the FULL text** of the main article body. Preserve original paragraph breaks (\n\n).
4.  **Strictly EXCLUDE ALL** non-article text and metadata: HTML tags, headlines, subheadings, bylines, dates, navigation, ads, related links, captions, comments, social media buttons, legal notices, scripts, styles, etc.
5.  Focus solely on the narrative content.

HTML Content:
\`\`\`html
${rawHtml}
\`\`\`
Verbatim Extracted Article Text:`;

        console.log(`🧠 Asking Gemini for *verbatim* text extraction: ${path.basename(rawHtmlFilePath)} (Temp: 0.1)...`);
        const extractedText = await ask_gemini(prompt, { temperature: 0.1 });
        if (!extractedText || extractedText.trim().length === 0) {
            console.warn(`⚠️ Gemini returned empty text for ${path.basename(rawHtmlFilePath)}. Skipping.`);
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


/** Generates the objective newsletter digest using Gemini */
async function generateNewsletterDigest(articlesData, outputPath, geminiModelOverride = null) {
    console.log(`\n💡 Aggregating content from ${articlesData.length} articles for Gemini DIGEST...`);
    let combinedContent = "Analyze the following news articles provided below, identified by their derived headlines and content, to generate a comprehensive daily news digest.\n\n";
    let currentLength = combinedContent.length;
    let includedCount = 0;

    for (const article of articlesData) {
         let headline = article.headline || `Article from ${article.url}`; // Use pre-derived headline
        const articleTextContent = article.text || '';
        const articleEntry = `--- ARTICLE START ---\nHeadline: ${headline}\nURL: ${article.url}\n\nContent:\n${articleTextContent}\n--- ARTICLE END ---\n\n`;
        const entryLength = articleEntry.length;

        if (currentLength + entryLength <= config.maxArticleContentLengthForGemini) {
            combinedContent += articleEntry;
            currentLength += entryLength;
            includedCount++;
        } else {
            console.warn(`   ⚠️ Truncating input for Gemini digest. Skipping article: ${headline.substring(0,50)}... due to length limits.`);
             const headlineEntry = `--- ARTICLE START ---\nHeadline: ${headline}\nURL: ${article.url}\n\nContent: [Content truncated due to length limits]\n--- ARTICLE END ---\n\n`;
             if (currentLength + headlineEntry.length <= config.maxArticleContentLengthForGemini) {
                combinedContent += headlineEntry;
                currentLength += headlineEntry.length;
             }
        }
    }

    if (includedCount === 0) { console.error("❌ No article content for Gemini digest."); return; }
    console.log(`   Aggregated content from ${includedCount} articles (${currentLength} chars) for Gemini digest.`);

    // Objective Digest Prompt (from previous steps)
    const prompt = `You are a neutral, objective news analyst. Synthesize the provided collection of news articles (separated by '--- ARTICLE START ---' and '--- ARTICLE END ---', including their headlines and verbatim content) into a comprehensive daily newsletter digest.

Format Requirements:
1.  **Overall Summary (Required):** Start with a brief (2-4 sentence) objective summary of the day's most significant news based *only* on the provided articles.
2.  **Key Story Summaries (Required):** Create sections for major themes (e.g., ## Politics, ## World News, ## Business). Under each theme, provide concise, factual summaries (3-6 sentences) of the relevant articles. Use the corresponding headline provided for each article.
3.  **Key Facts (Required):** List 3-5 bullet points highlighting verifiable facts reported across the articles under a heading \`## Key Facts Reported\`. Cite the source headline briefly in parentheses if helpful (e.g., "- Fact statement (Headline: ...)")
4.  **Narrative Analysis (Required):** Briefly (2-4 sentences) and neutrally discuss any overarching narratives, dominant perspectives, or potential points of contention observed *across* the provided articles under a heading \`## Narrative Analysis\`. Focus on *how* the news is presented.
5.  **Analyst's Note (Optional, Max 1):** If there is a particularly complex or significant story, you *may* add *one* short (1-2 sentences) section labeled \`## Analyst's Note\`. Provide brief, neutral context or potential implications derived *logically* from reported facts. **Do not express personal opinions or predictions.** Omit if unsure.

**Input Articles:**
${combinedContent}`;

    const modelToUse = geminiModelOverride || config.gemini.model;
    console.log(`🤖 Asking Gemini (${modelToUse}) to generate the objective newsletter digest...`);
    try {
        const newsletterContent = await ask_gemini(prompt, { model: modelToUse, temperature: config.gemini.temperature }); // Use default generation temp
        if (!newsletterContent) { console.error(`❌ Gemini (${modelToUse}) returned no response for digest.`); return; }
        const cleanedNewsletter = newsletterContent.replace(/```markdown\n?/, '').replace(/```$/, '').trim();
        await fs.writeFile(outputPath, cleanedNewsletter, 'utf8');
        console.log(`✅📰 Objective digest saved: ${path.basename(outputPath)}`);
    } catch (error) {
        console.error(`❌ Error generating digest with Gemini (${modelToUse}): ${error.message}`);
    }
}


/** Generates the analytical essay using Gemini - Includes Headline Derivation */
async function generateAnalyticalEssay(articlesData, outputPath, geminiModelOverride = null) {
    console.log(`\n💡 Aggregating content from ${articlesData.length} articles for Gemini ESSAY...`);
    let combinedContent = "Below is a collection of news articles from today. Each article includes its URL and verbatim text content, separated by '--- ARTICLE START ---' and '--- ARTICLE END ---'. Analyze this content to write your essay.\n\n";
    let currentLength = combinedContent.length;
    let includedCount = 0;

    for (const article of articlesData) {
        const articleTextContent = article.text || '';
        // NOTE: We no longer pre-fetch headlines here; the prompt asks Gemini to derive them.
        const articleEntry = `--- ARTICLE START ---\nURL: ${article.url}\n\nContent:\n${articleTextContent}\n--- ARTICLE END ---\n\n`;
        const entryLength = articleEntry.length;

        if (currentLength + entryLength <= config.maxArticleContentLengthForGemini) {
            combinedContent += articleEntry;
            currentLength += entryLength;
            includedCount++;
        } else {
            console.warn(`   ⚠️ Truncating input for Gemini essay. Skipping article from ${article.url.substring(0, 50)}... due to length limits.`);
            const headlineEntry = `--- ARTICLE START ---\nURL: ${article.url}\n\nContent: [Content truncated due to length limits]\n--- ARTICLE END ---\n\n`;
             if (currentLength + headlineEntry.length <= config.maxArticleContentLengthForGemini) {
                combinedContent += headlineEntry;
                currentLength += headlineEntry.length;
             }
        }
    }

    if (includedCount === 0) { console.error("❌ No article content for Gemini essay."); return; }
    console.log(`   Aggregated content from ${includedCount} articles (${currentLength} chars) for Gemini essay.`);

    // Essay Prompt (asking Gemini to derive headlines)
    const prompt = `You are a sophisticated news analyst and critical thinker with a distinct, engaging writing style. Based *only* on the collection of news articles provided below (delimited by '--- ARTICLE START ---' and '--- ARTICLE END ---', including their URLs and verbatim content), write a thoughtful analytical essay (approximately 500-1000 words). Your essay should critically respond to the key themes, events, and narratives presented, similar in depth and style to insightful editorial pieces.

Your essay should:
1.  **Identify and Introduce Themes:** Begin by identifying the most significant overarching theme(s) or critical event(s) emerging from the collective articles. Introduce your central argument or perspective on these themes.
2.  **Synthesize and Analyze:**
    *   Weave together information from different articles to support your analysis of the main themes. Discuss connections, contradictions, or different facets of the issues presented.
    *   Analyze the underlying narratives, potential implications, or unstated assumptions within the reporting. Go beyond surface-level summarization.
    *   **Derive and integrate concise headlines** for the articles you discuss to provide context for the reader, mentioning them naturally within your prose (e.g., "Reporting on the situation in Yemen, under the likely headline 'US Airstrikes Kill Dozens,' reveals...").
3.  **Offer Critical Perspective & Nuance:**
    *   Explore the complexities, ambiguities, or broader significance of the events *as suggested by the combined information in the texts*.
    *   Raise insightful questions or highlight tensions evident from the reporting.
    *   You may adopt a slightly more editorial or interpretive stance than a purely objective summary, but all points *must* be grounded in and logically derived from the provided article content. **Do not introduce external facts or opinions.**
4.  **Structure and Style:** Organize your thoughts into a coherent essay with a clear introduction, well-developed body paragraphs, and a strong conclusion. Employ sophisticated language and varied sentence structure.
5.  **Conclusion:** Synthesize your main analytical points and offer a final reflection on the significance of the day's news *as depicted in this collection*.

**Source Articles:**
${combinedContent}`;

    const modelToUse = geminiModelOverride || config.gemini.model;
    console.log(`✍️ Asking Gemini (${modelToUse}) to generate the analytical essay...`);
    try {
        const essayContent = await ask_gemini(prompt, { model: modelToUse, temperature: config.gemini.temperature });
        if (!essayContent) { console.error(`❌ Gemini (${modelToUse}) returned no response for essay.`); return; }
        const cleanedEssay = essayContent.replace(/```markdown\n?/, '').replace(/```$/, '').trim();
        await fs.writeFile(outputPath, cleanedEssay, 'utf8');
        console.log(`✅✍️ Analytical essay saved: ${path.basename(outputPath)}`);
    } catch (error) {
        console.error(`❌ Error generating essay with Gemini (${modelToUse}): ${error.message}`);
    }
}


// --- Function for Re-running Analysis ---
/**
 * Reads parsed text files from a specific directory and generates the selected analysis type.
 * @param {string} targetDirPath - Path to the source-specific date directory.
 * @param {'digest'|'essay'|'both'} analysisType - Type of analysis to generate.
 * @param {string|null} geminiModelOverride - Optional Gemini model name.
 */
async function generateAnalysisForDirectory(targetDirPath, analysisType = 'digest', geminiModelOverride = null) {
    console.log(`\n--- Rerunning Analysis for Directory: ${targetDirPath} ---`);
    console.log(`   Analysis Type: ${analysisType}`);
    if (geminiModelOverride) {
        console.log(`   Using specified Gemini model: ${geminiModelOverride}`);
    }

    const parsedTextDir = path.join(targetDirPath, 'parsed_text');
    const rawHtmlDir = path.join(targetDirPath, 'raw_html'); // Still useful for context/URLs

    try {
        await fs.access(parsedTextDir);
        const textFiles = await fs.readdir(parsedTextDir);
        const txtFileNames = textFiles.filter(f => f.endsWith('.txt'));

        if (txtFileNames.length === 0) {
            console.log(`🚫 No parsed text files found in ${parsedTextDir}.`);
            return;
        }

        console.log(`   Found ${txtFileNames.length} parsed text files.`);
        const articlesData = [];

        for (const txtFileName of txtFileNames) {
            const baseName = path.basename(txtFileName, '.txt');
            const txtFilePath = path.join(parsedTextDir, txtFileName);
             // Include raw HTML path for potential future use or headline hints
             const correspondingHtmlPath = path.join(rawHtmlDir, `${baseName}.html`);
             const htmlExists = await fs.access(correspondingHtmlPath).then(() => true).catch(() => false);

            try {
                const textContent = await fs.readFile(txtFilePath, 'utf8');
                articlesData.push({
                    url: `(source_file: ${baseName}.txt)`, // More informative placeholder
                    text: textContent,
                    rawHtmlPath: htmlExists ? correspondingHtmlPath : null // Pass if exists
                });
            } catch (readError) {
                console.warn(`   ⚠️ Skipping: Could not read text file "${txtFileName}". Error: ${readError.message}`);
            }
        }

        if (articlesData.length > 0) {
            const dirBaseName = path.basename(targetDirPath); // e.g., 'nytimes_email'
            const datePart = path.basename(path.dirname(targetDirPath)); // e.g., '2025-04-19'
            const modelSuffix = geminiModelOverride ? geminiModelOverride.replace(/[^a-zA-Z0-9]/g,'_') : 'default';

            // Generate Digest if requested
            if (analysisType === 'digest' || analysisType === 'both') {
                const digestFileName = `digest_${dirBaseName}_${datePart}_${modelSuffix}_${Date.now()}.md`;
                const digestOutputPath = path.join(targetDirPath, digestFileName);
                await generateNewsletterDigest(articlesData, digestOutputPath, geminiModelOverride);
            }

            // Generate Essay if requested
            if (analysisType === 'essay' || analysisType === 'both') {
                const essayFileName = `essay_${dirBaseName}_${datePart}_${modelSuffix}_${Date.now()}.md`;
                const essayOutputPath = path.join(targetDirPath, essayFileName);
                await generateAnalysisEssay(articlesData, essayOutputPath, geminiModelOverride);
            }
        } else {
            console.log("🚫 No valid article data loaded for re-analysis.");
        }

    } catch (error) {
        console.error(`❌ Error processing directory ${targetDirPath}: ${error.message}`);
        if (error.code === 'ENOENT') {
            console.error(`   Ensure the directory exists and contains 'parsed_text' subdirectory.`);
        }
    }
}


// --- Main Execution Logic ---
async function main() {
    // --- Command Line Argument Parsing ---
    const argv = yargs(hideBin(process.argv))
        .option('analyze-only', {
            alias: 'a',
            type: 'boolean',
            description: 'Only run analysis generation on an existing directory. Requires -d.',
            default: false
        })
        .option('directory', {
            alias: 'd',
            type: 'string',
            description: 'Path to the *source-specific* date directory (e.g., ./daily_news_data/YYYY-MM-DD/source_name) for --analyze-only mode.',
            implies: 'analyze-only' // Require -d if -a is used
        })
         .option('type', {
            alias: 't',
            type: 'string',
            choices: ['digest', 'essay', 'both'],
            description: 'Type of analysis to generate in analyze-only mode (or for full run).',
            default: 'both' // Default to generating both in full run
        })
        .option('model', {
            alias: 'm',
            type: 'string',
            description: `Override the default Gemini model for analysis generation (e.g., ${config.gemini.model}).`
        })
        .help()
        .alias('help', 'h')
        .argv;

    console.log("--- Starting Daily News Workflow (Gemini Only - Simplified Parsing) ---");

    if (!validateConfig()) {
        process.exit(1);
    }

    // --- Re-run Mode ---
    if (argv.analyzeOnly) {
        if (!argv.directory) { // yargs 'implies' should catch this, but double-check
            console.error("❌ Error: --directory (-d) argument is required when using --analyze-only.");
            process.exit(1);
        }
        const potentialPath = path.resolve(argv.directory);
        console.log(`▶️ Re-run Analysis Mode`);
        console.log(`   Target directory: ${potentialPath}`);
        console.log(`   Analysis Type: ${argv.type}`);
        if (argv.model) console.log(`   Using Model: ${argv.model}`);

        try {
            const stats = await fs.stat(potentialPath);
            if (stats.isDirectory()) {
                const resolvedBaseDir = path.resolve(config.scraper.outputBaseDir);
                if (potentialPath.startsWith(resolvedBaseDir) && potentialPath.includes(path.sep)) { // Basic check it's a subdir
                    await generateAnalysisForDirectory(potentialPath, argv.type, argv.model || null);
                } else {
                    console.error(`❌ Error: Path "${potentialPath}" is not a valid subdirectory within "${resolvedBaseDir}". Expected format: ${path.join(resolvedBaseDir, 'YYYY-MM-DD', 'source_name')}`);
                }
            } else {
                console.error(`❌ Error: Path "${potentialPath}" is not a directory.`);
            }
        } catch (error) {
             if (error.code === 'ENOENT') { console.error(`❌ Error: Directory "${potentialPath}" does not exist.`); }
             else { console.error(`❌ Error accessing directory "${potentialPath}": ${error.message}`); }
        }
        console.log("\n--- Re-run Analysis Complete ---");
        return; // Exit after re-run
    }

    // --- Full Scrape and Analysis Workflow ---
    console.log("▶️ Running Full Scrape and Analysis Workflow...");
    console.log(`   Generating analysis type(s): ${argv.type}`);
    if (argv.model) console.log(`   (Using specified model for final analysis: ${argv.model})`);


    const dateFolder = getCurrentDateFolder();
    const sourceUrlsFromFile = await readSourceUrls();
    const allArticlesData = []; // Aggregate data across all sources

    for (const sourceUrl of sourceUrlsFromFile) {
        console.log(`\n>>> Processing Source URL: ${sourceUrl}`);
        let sourceHtml;
        let sourceName = 'unknown_source';
        try {
            const parsedSourceUrl = new URL(sourceUrl);
            const hostname = parsedSourceUrl.hostname;
            sourceName = config.sourceMapping[hostname] || hostname.replace(/^www\.|^static\./g, '').split('.')[0];
            console.log(`   Source Identifier: ${sourceName}`);
        } catch (e) { console.error(`   Skipping invalid URL: ${sourceUrl}`); continue; }

        const { runDir, rawHtmlDir, parsedTextDir } = await setupDirectories(dateFolder, sourceName);

        console.log("\n--- Step 1: Fetching Source & Extracting Article URLs ---");
        sourceHtml = await fetchInitialHtml(sourceUrl);
        if (!sourceHtml) { console.warn(`   Skipping ${sourceName}: fetch error.`); continue; }

        const articleUrls = await extractArticleUrls(sourceHtml, sourceUrl); // Uses Gemini
        if (articleUrls.length === 0) { console.log(`   No article URLs extracted for ${sourceName}.`); continue; }

        console.log(`\n--- Step 2: Scraping ${articleUrls.length} Articles for ${sourceName} ---`);
        const scrapedArticlePaths = []; // Track successful scrapes for this source
        let scrapeCounter = 0;
        for (const url of articleUrls) {
            scrapeCounter++;
            console.log(`   Scraping ${scrapeCounter}/${articleUrls.length}: ${url.substring(0, 80)}...`);
            const rawHtmlFileName = urlToFilename(url, '.html');
            const rawHtmlFilePath = path.join(rawHtmlDir, rawHtmlFileName);
            const success = await scrapeAndSave(url, rawHtmlFilePath);
            if (success) { scrapedArticlePaths.push({ url, rawHtmlPath: rawHtmlFilePath }); }
            else { console.warn(`   Failed to scrape: ${url}`); }
            if (scrapeCounter < articleUrls.length) {
                 console.log(`   Waiting ${config.processingDelayMs / 1000}s...`);
                 await new Promise(resolve => setTimeout(resolve, config.processingDelayMs));
            }
        }

        if (scrapedArticlePaths.length === 0) { console.log(`🚫 No articles successfully scraped for ${sourceName}.`); continue; }

        console.log(`\n--- Step 3: Extracting Verbatim Text from ${scrapedArticlePaths.length} Scraped Articles (${sourceName}) ---`);
        let extractionCounter = 0;
        for (const article of scrapedArticlePaths) {
            extractionCounter++;
            console.log(`   Extracting text ${extractionCounter}/${scrapedArticlePaths.length}: ${path.basename(article.rawHtmlPath)}`);
            const baseName = path.basename(article.rawHtmlPath, '.html');
            const parsedTextFilePath = path.join(parsedTextDir, `${baseName}.txt`);
            const extractedText = await extractTextFromHtml(article.rawHtmlPath, parsedTextFilePath); // Uses Gemini
            if (extractedText) {
                // Add to the main list for combined analysis later
                allArticlesData.push({ url: article.url, text: extractedText, rawHtmlPath: article.rawHtmlPath, source: sourceName });
            }
            if (extractionCounter < scrapedArticlePaths.length) {
                 console.log(`   Waiting ${config.processingDelayMs / 1000 / 2}s...`);
                 await new Promise(resolve => setTimeout(resolve, config.processingDelayMs / 2));
            }
        }
    } // End loop through source URLs

    // --- Step 4: Generate the final outputs (Digest and/or Essay) ---
    if (allArticlesData.length > 0) {
        console.log(`\n--- Step 4: Generating Final Analysis from ${allArticlesData.length} Processed Articles ---`);
        const baseRunDir = path.join(config.scraper.outputBaseDir, dateFolder); // Base date folder for outputs
        await fs.mkdir(baseRunDir, { recursive: true }); // Ensure it exists

        const modelUsedSuffix = argv.model ? argv.model.replace(/[^a-zA-Z0-9]/g,'_') : 'default';

        // Generate Digest if requested (or default 'both')
        if (argv.type === 'digest' || argv.type === 'both') {
            const digestFileName = `daily_digest_${dateFolder}_${modelUsedSuffix}.md`;
            const digestOutputPath = path.join(baseRunDir, digestFileName);
            await generateNewsletterDigest(allArticlesData, digestOutputPath, argv.model || null);
        }

        // Generate Essay if requested (or default 'both')
        if (argv.type === 'essay' || argv.type === 'both') {
            const essayFileName = `analysis_essay_${dateFolder}_${modelUsedSuffix}.md`;
            const essayOutputPath = path.join(baseRunDir, essayFileName);
            await generateAnalysisEssay(allArticlesData, essayOutputPath, argv.model || null);
        }

    } else {
        console.log("\n🚫 No articles processed successfully. No final analysis generated.");
    }

    console.log("\n--- Workflow Complete ---");
}

// Run the main function
main().catch(error => {
  console.error("💥 Unhandled error in main workflow:", error);
  process.exit(1);
});
