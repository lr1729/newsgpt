// main.js
const fs = require('fs').promises;
const path = require('path');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const { config, validateConfig } = require('./config');
const { ask_gemini } = require('./gemini-module');
const { scrapeAndSave, scrapeAndGetContent } = require('./scraper');

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
        return data.split(/[\r\n]+/)
                   .map(line => line.trim())
                   .filter(line => line && !line.startsWith('#'));
    } catch (error) {
        console.error(`❌ Error reading source URL file (${config.sourceListFile}): ${error.message}`);
        return [];
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
        if (!filename) {
           filename = `source_${parsedUrl.hostname.replace(/[^a-zA-Z0-9]/g, '_')}_${Date.now()}`;
        }
        return filename + extension;
    } catch (e) {
        console.warn(`Warning: Could not parse URL "${url}" for filename generation.`);
        return `invalid_url_${Date.now()}${extension}`;
    }
}


// --- AI Interaction Functions ---

/** Extracts likely article URLs using Gemini */
async function extractArticleUrls(sourceHtml, sourceUrl) {
    let targetDomain = 'unknown_domain';
     try { targetDomain = new URL(sourceUrl).hostname; } catch {}
    const prompt = `Analyze the following HTML source code from ${sourceUrl}. Extract *every single distinct* absolute URL that appears to be a link to a primary news article hosted on the domain '${targetDomain}' or its direct subdomains (like www.${targetDomain.replace(/^static\./,'')}).

CRITICAL RULES:
1. Output *ONLY* the full, valid URLs, each on a new line. NO intro, explanation, or labels.
2. The URL must start with 'http://' or 'https://' and point to the target domain (or www. subdomain).
3. Prioritize URLs clearly linked from headlines, article summaries, or prominent story links.
4. The URL path should look like it leads to specific content (e.g., contain multiple segments, end in .html, or include date patterns YYYY/MM/DD), not just a base path or section index.
5. **Strictly EXCLUDE ALL** links clearly identifiable as: section/category pages, author/tag pages, ads, trackers, login/subscription links, site navigation (header/footer), help/contact/policy pages, social media, multimedia galleries, email actions, file downloads, paid content sections, archive pages (unless linking to specific articles), /svc/messaging/, etc.

List only the valid, full article URLs, one per line. Preserve the original URL structure including query parameters.

HTML Content:
\`\`\`html
${sourceHtml}
\`\`\`
Extracted Article URLs:`;

    console.log(`🧠 Asking Gemini to extract likely article URLs from ${sourceUrl} (Temp: 0.1)...`);
    try {
        const response = await ask_gemini(prompt, { temperature: 0.1 });
        if (!response) { console.error("❌ Gemini returned no response for URL extraction."); return []; }
        const urls = response
            .split(/[\r\n]+/)
            .map(line => line.trim().replace(/^[-*]\s*/, ''))
            .filter(line => {
                if (!line.startsWith('http')) return false;
                try { // Minimal check: starts with http and is parsable
                    new URL(line);
                    return true;
                } catch { return false; }
            });
        const uniqueUrls = [...new Set(urls)];
        console.log(`📰 Gemini returned ${uniqueUrls.length} potential URLs for ${targetDomain}.`);
        if (uniqueUrls.length > 0) {
            console.log("--- URLs Provided by Gemini (minimal code filtering) ---");
            uniqueUrls.forEach(url => console.log(url));
            console.log("-------------------------------------------------------");
        } else { console.log("   (Gemini did not return any lines starting with http)"); }
        return uniqueUrls;
    } catch (error) { console.error(`❌ Error during URL extraction with Gemini: ${error.message}`); return []; }
}

/** Extracts verbatim text content using Gemini */
async function extractTextFromHtml(rawHtmlFilePath, parsedTextFilePath) {
    console.log(`📄 Reading raw HTML for text extraction: ${path.basename(rawHtmlFilePath)}`);
    try {
        const rawHtml = await fs.readFile(rawHtmlFilePath, 'utf8');
        const prompt = `Your primary goal is to extract the *complete and verbatim textual content* of the main news article body from the following HTML source code. Reproduce the text exactly as it appears in the article's primary paragraphs.

CRITICAL INSTRUCTIONS:
1.  **Output ONLY the plain text** of the article's core narrative content.
2.  **DO NOT SUMMARIZE, PARAPHRASE, REPHRASE, or CHANGE** any of the original article wording. Keep all original sentences and paragraphs intact.
3.  **Extract the FULL text** of the main article body.
4.  **Strictly EXCLUDE ALL** non-article text and metadata, including: HTML tags, headlines, subheadings, bylines, dates, navigation, ads, related links, captions, comments, social media buttons, legal notices, scripts, styles, etc.
5.  Focus solely on the narrative content. If the HTML contains multiple distinct articles, extract only the most prominent one.
6.  Format the output as clean paragraphs separated by double newlines (\n\n). Preserve original paragraph breaks.

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

/** Aggregates article data for final analysis */
async function aggregateArticleData(articlesToProcess) {
    console.log(`\n💡 Aggregating content from ${articlesToProcess.length} articles for final analysis...`);
   let combinedContent = "Analyze the following news articles provided below. Each article includes its URL and verbatim text content, separated by '--- ARTICLE START ---' and '--- ARTICLE END ---'.\n\n";
   let currentLength = combinedContent.length;
   let includedCount = 0;
   const processedArticles = [];

   for (const article of articlesToProcess) {
       const articleTextContent = article.text || '';
       const articleEntry = `--- ARTICLE START ---\nURL: ${article.url}\n\nContent:\n${articleTextContent}\n--- ARTICLE END ---\n\n`;
       const entryLength = articleEntry.length;

       if (currentLength + entryLength <= config.maxArticleContentLengthForGemini) {
           combinedContent += articleEntry;
           currentLength += entryLength;
           includedCount++;
           processedArticles.push(article);
       } else {
           console.warn(`   ⚠️ Truncating input for Gemini analysis. Skipping article from ${article.url.substring(0, 50)}... due to length limits.`);
            const headlineEntry = `--- ARTICLE START ---\nURL: ${article.url}\n\nContent: [Content truncated due to length limits]\n--- ARTICLE END ---\n\n`;
            if (currentLength + headlineEntry.length <= config.maxArticleContentLengthForGemini) {
               combinedContent += headlineEntry;
               currentLength += headlineEntry.length;
            }
       }
   }

   if (includedCount === 0) {
       console.error("❌ No article content could be included for Gemini analysis.");
       return { combinedContent: null, processedArticles: [] };
   }

   console.log(`   Aggregated content from ${includedCount} articles (${currentLength} chars).`);
   return { combinedContent, processedArticles };
}


/** Generates the objective newsletter digest using Gemini */
async function generateNewsletterDigest(aggregatedContent, outputPath, geminiModelOverride = null) {
    const prompt = `You are a neutral, objective news analyst. Synthesize the provided collection of news articles (delimited by '--- ARTICLE START ---' and '--- ARTICLE END ---') into a comprehensive daily newsletter digest.

Format Requirements:
1.  **Derive Headlines:** Internally determine a concise, accurate headline for each article based on its content.
2.  **Overall Summary (Required):** Start with a brief (2-4 sentence) objective summary of the day's most significant news based *only* on the provided articles.
3.  **Key Story Summaries (Required):** Create sections for major themes (e.g., ## Politics, ## World News, ## Business). Under each theme, provide concise, factual summaries (3-6 sentences) of the relevant articles. **Use the headlines you derived**.
4.  **Key Facts (Required):** List 3-5 bullet points highlighting verifiable facts reported across the articles under a heading \`## Key Facts Reported\`.
5.  **Narrative Analysis (Required):** Briefly (2-4 sentences) and neutrally discuss any overarching narratives or dominant perspectives observed *across* the provided articles under a heading \`## Narrative Analysis\`.
6.  **Analyst's Note (Optional, Max 1):** You *may* add *one* short (1-2 sentences) section labeled \`## Analyst's Note\` offering brief, neutral context or potential implications derived *only* from the reported facts. Omit if unsure.

**Input Articles:**
${aggregatedContent}`;

    const modelToUse = geminiModelOverride || config.gemini.model;
    console.log(`🤖 Asking Gemini (${modelToUse}) to generate the objective newsletter digest...`);
    try {
        const newsletterContent = await ask_gemini(prompt, { model: modelToUse, temperature: config.gemini.temperature });
        if (!newsletterContent) { console.error(`❌ Gemini (${modelToUse}) returned no response for digest.`); return; }
        const cleanedNewsletter = newsletterContent.replace(/```markdown\n?/, '').replace(/```$/, '').trim();
        await fs.writeFile(outputPath, cleanedNewsletter, 'utf8');
        console.log(`✅📰 Objective digest saved: ${path.basename(outputPath)}`);
    } catch (error) { console.error(`❌ Error generating digest with Gemini (${modelToUse}): ${error.message}`); }
}


/** Generates the analytical essay using Gemini */
async function generateAnalysisEssay(aggregatedContent, outputPath, geminiModelOverride = null) {
    const prompt = `You are a sophisticated news analyst and critical thinker with a distinct, engaging writing style. Based *only* on the collection of news articles provided below (delimited by '--- ARTICLE START ---' and '--- ARTICLE END ---', including their URLs and verbatim content), write a thoughtful analytical essay (approximately 500-1000 words) responding to the key themes, events, and narratives presented in today's news.

Your essay should demonstrate high-quality writing, critical comprehension, and objective analysis. Structure your essay logically:

1.  **Introduction:** Briefly identify and introduce the most prominent overarching theme(s) or the most significant event(s) emerging from the collection of articles. Set the stage for your analysis.
2.  **Synthesis and Analysis:**
    *   Weave together information from different articles to support your analysis of the main themes. Discuss connections, contradictions, or different facets of the issues presented.
    *   Analyze the underlying narratives or potential implications within the reporting. Go beyond surface-level summarization.
    *   **Derive and integrate concise headlines** for the articles you discuss to provide context for the reader, mentioning them naturally within your prose (e.g., "Reporting on the situation in Yemen, under the likely headline 'US Airstrikes Kill Dozens,' reveals...").
3.  **Critical Reflection & Nuance:**
    *   Explore the complexities, ambiguities, or broader significance of the events *as suggested by the combined information in the texts*.
    *   Raise insightful questions or highlight tensions evident from the reporting.
    *   Adopt an analytical and interpretive stance grounded *only* in the provided article content. **Do not inject external facts or personal opinions.**
4.  **Conclusion:** Provide a concise concluding thought that synthesizes your main analytical points and reflects on the significance of the day's news *as depicted in this collection*.

**Maintain an analytical and formal tone throughout.**

**Source Articles:**
${aggregatedContent}`;

    const modelToUse = geminiModelOverride || config.gemini.model;
    console.log(`✍️ Asking Gemini (${modelToUse}) to generate the analytical essay...`);
    try {
        const essayContent = await ask_gemini(prompt, { model: modelToUse, temperature: config.gemini.temperature });
        if (!essayContent) { console.error(`❌ Gemini (${modelToUse}) returned no response for essay.`); return; }
        const cleanedEssay = essayContent.replace(/```markdown\n?/, '').replace(/```$/, '').trim();
        await fs.writeFile(outputPath, cleanedEssay, 'utf8');
        console.log(`✅✍️ Analytical essay saved: ${path.basename(outputPath)}`);
    } catch (error) { console.error(`❌ Error generating essay with Gemini (${modelToUse}): ${error.message}`); }
}


// --- Function for Running ONLY Extraction ---
/**
 * Reads raw HTML files from a directory and runs text extraction.
 * @param {string} targetDirPath - Path to the source-specific date directory.
 */
async function extractOnlyForDirectory(targetDirPath) {
    console.log(`\n--- Running Extraction Only for Directory: ${targetDirPath} ---`);
    const rawHtmlDir = path.join(targetDirPath, 'raw_html');
    const parsedTextDir = path.join(targetDirPath, 'parsed_text');
    const extractionDelay = 10000; // 10 seconds delay

    try {
        await fs.access(rawHtmlDir);
        await fs.mkdir(parsedTextDir, { recursive: true });
        const htmlFiles = await fs.readdir(rawHtmlDir);
        const htmlFileNames = htmlFiles.filter(f => f.endsWith('.html'));
        if (htmlFileNames.length === 0) { console.log(`🚫 No raw HTML files found in ${rawHtmlDir}.`); return; }

        console.log(`   Found ${htmlFileNames.length} raw HTML files to process.`);
        let extractionCounter = 0;
        let successCounter = 0;

        for (const htmlFileName of htmlFileNames) {
            extractionCounter++;
            const rawHtmlFilePath = path.join(rawHtmlDir, htmlFileName);
            const baseName = path.basename(htmlFileName, '.html');
            const parsedTextFilePath = path.join(parsedTextDir, `${baseName}.txt`);
            console.log(`   Extracting text ${extractionCounter}/${htmlFileNames.length}: ${htmlFileName}`);
            const extractedText = await extractTextFromHtml(rawHtmlFilePath, parsedTextFilePath);
            if (extractedText !== null) { successCounter++; }
            else { console.warn(`   Extraction failed for ${htmlFileName} after retries.`); }
            if (extractionCounter < htmlFileNames.length) {
                 console.log(`   Waiting ${extractionDelay / 1000}s before next extraction...`);
                 await new Promise(resolve => setTimeout(resolve, extractionDelay));
            }
        }
        console.log(`\n--- Extraction Only Complete for ${targetDirPath} ---`);
        console.log(`   Successfully extracted text for ${successCounter}/${htmlFileNames.length} files.`);
    } catch (error) {
        console.error(`❌ Error processing directory for extraction ${targetDirPath}: ${error.message}`);
        if (error.code === 'ENOENT') { console.error(`   Ensure the directory exists and contains a 'raw_html' subdirectory.`); }
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
    if (geminiModelOverride) { console.log(`   Using specified Gemini model: ${geminiModelOverride}`); }

    const parsedTextDir = path.join(targetDirPath, 'parsed_text');

    try {
        await fs.access(parsedTextDir);
        const textFiles = await fs.readdir(parsedTextDir);
        const txtFileNames = textFiles.filter(f => f.endsWith('.txt'));
        if (txtFileNames.length === 0) { console.log(`🚫 No parsed text files found in ${parsedTextDir}.`); return; }

        console.log(`   Found ${txtFileNames.length} parsed text files.`);
        const articlesData = [];
        for (const txtFileName of txtFileNames) {
            const txtFilePath = path.join(parsedTextDir, txtFileName);
            try {
                const textContent = await fs.readFile(txtFilePath, 'utf8');
                articlesData.push({ url: `(source_file: ${txtFileName})`, text: textContent, rawHtmlPath: null }); // rawHtmlPath not needed here
            } catch (readError) { console.warn(`   ⚠️ Skipping: Could not read text file "${txtFileName}". ${readError.message}`); }
        }

        if (articlesData.length > 0) {
            const { combinedContent } = await aggregateArticleData(articlesData);
            if (!combinedContent) { console.error("❌ Failed to aggregate content for re-analysis."); return; }

            const dirBaseName = path.basename(targetDirPath);
            const datePart = path.basename(path.dirname(targetDirPath));
            const modelSuffix = geminiModelOverride ? geminiModelOverride.replace(/[^a-zA-Z0-9]/g,'_') : 'default';

            if (analysisType === 'digest' || analysisType === 'both') {
                const digestFileName = `digest_${dirBaseName}_${datePart}_${modelSuffix}_${Date.now()}.md`;
                const digestOutputPath = path.join(targetDirPath, digestFileName);
                await generateNewsletterDigest(combinedContent, digestOutputPath, geminiModelOverride);
            }
            if (analysisType === 'essay' || analysisType === 'both') {
                const essayFileName = `essay_${dirBaseName}_${datePart}_${modelSuffix}_${Date.now()}.md`;
                const essayOutputPath = path.join(targetDirPath, essayFileName);
                await generateAnalysisEssay(combinedContent, essayOutputPath, geminiModelOverride);
            }
        } else { console.log("🚫 No valid article data loaded for re-analysis."); }
    } catch (error) {
        console.error(`❌ Error processing directory ${targetDirPath}: ${error.message}`);
        if (error.code === 'ENOENT') { console.error(`   Ensure the directory exists and contains 'parsed_text' subdirectory.`); }
    }
}


// --- Main Execution Logic ---
async function main() {
    // --- Command Line Argument Parsing ---
    const argv = yargs(hideBin(process.argv))
        .option('analyze-only', {
            alias: 'a',
            type: 'boolean',
            description: 'Only run final analysis generation (digest/essay) on an existing directory. Requires -d.',
            default: false,
            // Removed conflicts
        })
        .option('extract-only', {
            alias: 'e',
            type: 'boolean',
            description: 'Only run verbatim text extraction on raw HTML files in an existing directory. Requires -d.',
            default: false,
            // Removed conflicts
        })
        .option('directory', {
            alias: 'd',
            type: 'string',
            description: 'Path to the source-specific date directory (e.g., ./daily_news_data/YYYY-MM-DD/source_name) for --analyze-only or --extract-only modes.',
            // Required only if -a or -e is used (checked below)
        })
        .option('type', {
            alias: 't',
            type: 'string',
            choices: ['digest', 'essay', 'both'],
            description: 'Type of analysis to generate (used with -a or full run).',
            default: 'both'
        })
        .option('model', {
            alias: 'm',
            type: 'string',
            description: `Override Gemini model for analysis (Default: ${config.gemini.model}).`
        })
        .check((argv) => { // Custom validation for directory requirement
             if ((argv.analyzeOnly || argv.extractOnly) && !argv.directory) {
                 throw new Error("Error: --directory (-d) argument is required when using --analyze-only (-a) or --extract-only (-e).");
             }
             // Check for mutually exclusive flags in logic, not here
             if (argv.analyzeOnly && argv.extractOnly) {
                 throw new Error("Error: Options --analyze-only (-a) and --extract-only (-e) are mutually exclusive.");
             }
             return true; // Tell yargs validation passed
         })
        .help()
        .alias('help', 'h')
        .argv;

    console.log("--- Starting Daily News Workflow (Gemini Only - Trusting AI - Faster Delays) ---");

    if (!validateConfig()) { process.exit(1); }

    // --- Handle Special Modes ---
    if (argv.extractOnly) {
        const potentialPath = path.resolve(argv.directory);
        console.log(`▶️ Extract Only Mode`);
        console.log(`   Target directory: ${potentialPath}`);
        try {
            const stats = await fs.stat(potentialPath);
            if (!stats.isDirectory()) throw new Error("Path is not a directory.");
            const resolvedBaseDir = path.resolve(config.scraper.outputBaseDir);
             if (!potentialPath.startsWith(resolvedBaseDir) || potentialPath === resolvedBaseDir) throw new Error(`Path must be a subdirectory within ${resolvedBaseDir}`);
            await extractOnlyForDirectory(potentialPath); // Call the extraction only function
        } catch (error) {
            if (error.code === 'ENOENT') { console.error(`❌ Error: Directory "${potentialPath}" does not exist.`); }
            else { console.error(`❌ Error processing directory "${potentialPath}": ${error.message}`); }
        }
        console.log("\n--- Extract Only Complete ---");
        return; // Exit

    } else if (argv.analyzeOnly) {
        // --- Re-run Analysis Mode ---
        const potentialPath = path.resolve(argv.directory);
        console.log(`▶️ Re-run Analysis Mode`);
        console.log(`   Target directory: ${potentialPath}`);
        console.log(`   Analysis Type: ${argv.type}`);
        if (argv.model) console.log(`   Using Model: ${argv.model}`);
        try {
            const stats = await fs.stat(potentialPath);
            if (!stats.isDirectory()) throw new Error("Path is not a directory.");
            const resolvedBaseDir = path.resolve(config.scraper.outputBaseDir);
            if (!potentialPath.startsWith(resolvedBaseDir) || potentialPath === resolvedBaseDir) throw new Error(`Path must be a subdirectory within ${resolvedBaseDir}`);
            await generateAnalysisForDirectory(potentialPath, argv.type, argv.model || null);
        } catch (error) {
             if (error.code === 'ENOENT') { console.error(`❌ Error: Directory "${potentialPath}" does not exist.`); }
             else { console.error(`❌ Error processing directory "${potentialPath}": ${error.message}`); }
        }
        console.log("\n--- Re-run Analysis Complete ---");
        return; // Exit
    }

    // --- Full Scrape and Analysis Workflow ---
    console.log("▶️ Running Full Scrape and Analysis Workflow...");
    console.log(`   Generating analysis type(s): ${argv.type}`);
    if (argv.model) console.log(`   (Using specified model for final analysis: ${argv.model})`);

    const dateFolder = getCurrentDateFolder();
    const sourceUrlsFromFile = await readSourceUrls();
    const allArticlesData = []; // Aggregate across all sources

    const interScrapeDelay = config.processingDelayMs / 2 > 1000 ? config.processingDelayMs / 2 : 1000;
    const interExtractionDelay = 10000; // Keep 10s delay for extraction API calls

    for (const sourceUrl of sourceUrlsFromFile) {
        console.log(`\n>>> Processing Source URL: ${sourceUrl}`);
        let sourceHtmlContent;
        let sourceName = 'unknown_source';
         try {
            const parsedSourceUrl = new URL(sourceUrl);
            const hostname = parsedSourceUrl.hostname;
            sourceName = hostname.replace(/^www\.|^static\./g, '').split('.')[0];
            console.log(`   Source Identifier: ${sourceName}`);
        } catch (e) { console.error(`   Skipping invalid URL: ${sourceUrl}`); continue; }

        const { rawHtmlDir, parsedTextDir } = await setupDirectories(dateFolder, sourceName);

        console.log("\n--- Step 1: Scraping Source & Extracting Article URLs ---");
        sourceHtmlContent = await scrapeAndGetContent(sourceUrl); // Use Puppeteer
        if (!sourceHtmlContent) { console.warn(`   Skipping ${sourceName}: source scrape error.`); continue; }

        const articleUrls = await extractArticleUrls(sourceHtmlContent, sourceUrl); // Use Gemini (minimal filtering)
        if (articleUrls.length === 0) { console.log(`   No likely article URLs found by Gemini for ${sourceName}.`); continue; }

        console.log(`\n--- Step 2: Scraping ${articleUrls.length} Articles for ${sourceName} ---`);
        const scrapedArticlePaths = [];
        let scrapeCounter = 0;
        for (const url of articleUrls) {
            scrapeCounter++;
            console.log(`   Scraping ${scrapeCounter}/${articleUrls.length}: ${url.substring(0, 80)}...`);
            const rawHtmlFileName = urlToFilename(url, '.html');
            const rawHtmlFilePath = path.join(rawHtmlDir, rawHtmlFileName);
            const success = await scrapeAndSave(url, rawHtmlFilePath); // Use Puppeteer scraper
            if (success) { scrapedArticlePaths.push({ url, rawHtmlPath: rawHtmlFilePath }); }
            else { console.warn(`   Failed to scrape: ${url}`); }
            if (scrapeCounter < articleUrls.length) {
                 console.log(`   Waiting ${interScrapeDelay / 1000}s...`);
                 await new Promise(resolve => setTimeout(resolve, interScrapeDelay));
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
            const extractedText = await extractTextFromHtml(article.rawHtmlPath, parsedTextFilePath); // Use Gemini
            if (extractedText !== null) { // Check for null from retry failure
                allArticlesData.push({ url: article.url, text: extractedText, rawHtmlPath: article.rawHtmlPath, source: sourceName });
            } else {
                 console.warn(`   Skipping article ${baseName} due to extraction failure after retries.`);
            }
            if (extractionCounter < scrapedArticlePaths.length) {
                 console.log(`   Waiting ${interExtractionDelay / 1000}s before next extraction...`);
                 await new Promise(resolve => setTimeout(resolve, interExtractionDelay)); // Use 10s delay
            }
        }
    } // End source URL loop

    // --- Step 4: Generate the final outputs ---
    if (allArticlesData.length > 0) {
        console.log(`\n--- Step 4: Generating Final Analysis from ${allArticlesData.length} Processed Articles ---`);
        const baseRunDir = path.join(config.scraper.outputBaseDir, dateFolder);
        await fs.mkdir(baseRunDir, { recursive: true });
        const modelUsedSuffix = argv.model ? argv.model.replace(/[^a-zA-Z0-9]/g,'_') : 'default';

        const { combinedContent } = await aggregateArticleData(allArticlesData);

        if (combinedContent) {
            if (argv.type === 'digest' || argv.type === 'both') {
                const digestFileName = `daily_digest_${dateFolder}_${modelUsedSuffix}.md`;
                const digestOutputPath = path.join(baseRunDir, digestFileName);
                await generateNewsletterDigest(combinedContent, digestOutputPath, argv.model || null);
            }
            if (argv.type === 'essay' || argv.type === 'both') {
                const essayFileName = `analysis_essay_${dateFolder}_${modelUsedSuffix}.md`;
                const essayOutputPath = path.join(baseRunDir, essayFileName);
                await generateAnalysisEssay(combinedContent, essayOutputPath, argv.model || null);
            }
        } else { console.log("🚫 Aggregated content was empty. No final analysis generated."); }
    } else { console.log("\n🚫 No articles processed successfully. No final analysis generated."); }

    console.log("\n--- Workflow Complete ---");
}

// Run the main function
main().catch(error => {
  console.error("💥 Unhandled error in main workflow:", error);
  process.exit(1);
});
