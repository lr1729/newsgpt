// main.js
const fs = require('fs').promises;
const path = require('path');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const { config, validateConfig } = require('./config'); // Ensure config.js is updated
const { ask_gemini } = require('./gemini-module'); // Ensure gemini-module.js has retry logic
// Ensure scraper.js exports both scrapeAndSave and scrapeAndGetContent
const { scrapeAndSave, scrapeAndGetContent } = require('./scraper');

// --- Helper Functions ---

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
    const runDir = path.join(baseDir, dateFolder, sourceName); // Source-specific dir
    const rawHtmlDir = path.join(runDir, 'raw_html');
    const parsedTextDir = path.join(runDir, 'parsed_text');
    // Ensure base date directory also exists for combined reports later
    const baseDateDir = path.join(baseDir, dateFolder);
    await fs.mkdir(rawHtmlDir, { recursive: true });
    await fs.mkdir(parsedTextDir, { recursive: true });
    await fs.mkdir(baseDateDir, { recursive: true }); // Ensure base date dir exists

    console.log(`🗂️ Output directories for ${sourceName} (${dateFolder}):`);
    console.log(`   - Raw HTML: ${rawHtmlDir}`);
    console.log(`   - Parsed Text: ${parsedTextDir}`);
    return { runDir, rawHtmlDir, parsedTextDir, baseDateDir }; // Return baseDateDir as well
}

/** Reads URLs from the source list file */
async function readSourceUrls() {
    try {
        const data = await fs.readFile(config.sourceListFile, 'utf8');
        return data.split(/[\r\n]+/) // Handles different line endings
                   .map(line => line.trim())
                   .filter(line => line && !line.startsWith('#')); // Ignore empty lines and comments
    } catch (error) {
        console.error(`❌ Error reading source URL file (${config.sourceListFile}): ${error.message}`);
        return [];
    }
}

/** Creates a filesystem-safe filename from a URL */
function urlToFilename(url, extension = '.html') {
    try {
        const parsedUrl = new URL(url);
        // Combine hostname and path/query for uniqueness, replace minimal unsafe chars
        let filename = parsedUrl.hostname + parsedUrl.pathname + (parsedUrl.search || '');
        filename = filename.replace(/^\/+|\/+$/g, '') // Trim slashes
                           .replace(/[\/\\]/g, '_')     // Replace path separators
                           .replace(/[:*?"<>|]/g, '_'); // Replace other common invalid chars
                           // Keep periods and equals signs common in URLs
        filename = filename.replace(/\.html$/i, ''); // Remove original .html if present
        filename = filename.substring(0, 180); // Limit length slightly more generously
        if (!filename) { // Fallback for edge cases like root path only
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
Extracted Article URLs:`; // Send full HTML

    console.log(`🧠 Asking Gemini to extract likely article URLs from ${sourceUrl} (Temp: 0.1)...`);
    try {
        const response = await ask_gemini(prompt, { temperature: 0.1 });
        if (!response) { console.error("❌ Gemini returned no response for URL extraction."); return []; }
        // Minimal filtering: just check if it starts with http and is parsable
        const urls = response
            .split(/[\r\n]+/)
            .map(line => line.trim().replace(/^[-*]\s*/, ''))
            .filter(line => {
                if (!line.startsWith('http')) return false;
                try { new URL(line); return true; } catch { return false; }
            });
        const uniqueUrls = [...new Set(urls)];
        console.log(`📰 Gemini returned ${uniqueUrls.length} potential URLs for ${targetDomain}.`);
        if (uniqueUrls.length > 0) {
            console.log("--- URLs Provided by Gemini (minimal code filtering) ---");
            uniqueUrls.forEach(url => console.log(url));
            console.log("-------------------------------------------------------");
        } else { console.log("   (Gemini did not return any lines starting with http)"); }
        return uniqueUrls; // Rely on Gemini's filtering primarily
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
Verbatim Extracted Article Text:`; // Send full HTML

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

/** Aggregates article data for SOURCE-SPECIFIC analysis */
async function aggregateArticleDataForSource(articlesToProcess) {
    console.log(`\n💡 Aggregating content from ${articlesToProcess.length} articles for source-specific analysis...`);
    let combinedContent = "Analyze the following news articles provided below. Each article includes its URL and verbatim text content, separated by '--- ARTICLE START ---' and '--- ARTICLE END ---'.\n\n";
    let currentLength = combinedContent.length;
    let includedCount = 0;

    for (const article of articlesToProcess) {
        const articleTextContent = article.text || '';
        const articleEntry = `--- ARTICLE START ---\nURL: ${article.url}\n\nContent:\n${articleTextContent}\n--- ARTICLE END ---\n\n`;
        const entryLength = articleEntry.length;
        if (currentLength + entryLength <= config.maxArticleContentLengthForGemini) {
            combinedContent += articleEntry;
            currentLength += entryLength;
            includedCount++; // Increment only if added
        } else {
            console.warn(`   ⚠️ Truncating input for source-specific analysis. Skipping article from ${article.url.substring(0, 50)}... due to length limits.`);
            // Optionally add truncated marker if needed by subsequent steps
             const headlineEntry = `--- ARTICLE START ---\nURL: ${article.url}\n\nContent: [Content truncated due to length limits]\n--- ARTICLE END ---\n\n`;
             if (currentLength + headlineEntry.length <= config.maxArticleContentLengthForGemini) {
                combinedContent += headlineEntry;
                currentLength += headlineEntry.length;
             }
        }
    }
     // Handle edge case where all articles were too long
     if (includedCount === 0 && articlesToProcess.length > 0) {
         const firstArticleText = articlesToProcess[0]?.text || '';
         const firstEntry = `--- ARTICLE START ---\nURL: ${articlesToProcess[0]?.url}\n\nContent:\n${firstArticleText.substring(0, 1000)}... [Content Truncated]\n--- ARTICLE END ---\n\n`;
         if(firstEntry.length <= config.maxArticleContentLengthForGemini){
             combinedContent += firstEntry;
             includedCount++;
         }
    }
    if (includedCount === 0) {
        console.error("❌ No article content could be included for source-specific analysis.");
        return null; // Return null if no content could be aggregated
    }
    console.log(`   Aggregated source content from ${includedCount} articles (${currentLength} chars).`);
    return combinedContent; // Return only the combined string
}

/** Aggregates content from previously generated source-specific MD files for FINAL analysis */
async function aggregateAnalysisFiles(processedSourcesData, analysisFileType = 'digest') { // 'digest' or 'essay'
    console.log(`\n💡 Aggregating source-specific ${analysisFileType} files for final combined analysis...`);
    let combinedAnalysisInput = `Synthesize the following source-specific ${analysisFileType}s into a comprehensive overview for the day.\n\n`;
    let combinedLength = combinedAnalysisInput.length;
    let sourcesIncludedCount = 0;

    for (const sourceData of processedSourcesData) {
        console.log(`   Reading ${analysisFileType} for source: ${sourceData.sourceName}`);
        const pattern = `${analysisFileType}_${sourceData.sourceName}_`;
        let fileContent = null;
        let fileNameFound = null;

        try {
            // Ensure the source directory exists before trying to read it
            if (!require('fs').existsSync(sourceData.runDir)) {
                 console.warn(`   Source directory not found, cannot read analysis file: ${sourceData.runDir}`);
                 continue; // Skip to the next source
            }

            const files = await fs.readdir(sourceData.runDir);
            // Find the latest timestamped file for this type/source/date
            const matchingFiles = files
                .filter(f => f.startsWith(pattern) && f.endsWith('.md'))
                .sort((a, b) => { // Sort by timestamp descending
                    const timeA = parseInt(a.split('_').pop().replace('.md', ''), 10) || 0;
                    const timeB = parseInt(b.split('_').pop().replace('.md', ''), 10) || 0;
                    return timeB - timeA;
                });

            if (matchingFiles.length > 0) {
                fileNameFound = matchingFiles[0];
                fileContent = await fs.readFile(path.join(sourceData.runDir, fileNameFound), 'utf8');
                console.log(`      Found and read: ${fileNameFound}`);
            } else {
                 console.warn(`   No ${analysisFileType} file found matching pattern "${pattern}*.md" in ${sourceData.runDir}`);
            }
        } catch (e) {
             console.warn(`   Could not read ${analysisFileType} file for ${sourceData.sourceName} in ${sourceData.runDir}: ${e.message}`);
        }

        if (fileContent) {
            const sourceEntry = `--- SOURCE START: ${sourceData.sourceName} ---\nSource File: ${fileNameFound}\n\n${fileContent}\n--- SOURCE END: ${sourceData.sourceName} ---\n\n`;
            if (combinedLength + sourceEntry.length <= config.maxArticleContentLengthForGemini) {
                combinedAnalysisInput += sourceEntry;
                combinedLength += sourceEntry.length;
                sourcesIncludedCount++;
            } else {
                console.warn(`   ⚠️ Truncating input for final combined analysis. Skipping ${analysisFileType} from ${sourceData.sourceName} due to length limits.`);
                 const truncatedEntry = `--- SOURCE START: ${sourceData.sourceName} ---\nSource File: ${fileNameFound}\n\n[Content truncated due to length limits]\n--- SOURCE END: ${sourceData.sourceName} ---\n\n`;
                 if (combinedLength + truncatedEntry.length <= config.maxArticleContentLengthForGemini) {
                     combinedAnalysisInput += truncatedEntry;
                     combinedLength += truncatedEntry.length;
                 }
            }
        }
    }

    if (sourcesIncludedCount === 0) {
        console.error(`❌ No source-specific ${analysisFileType} files could be successfully aggregated.`);
        return null;
    }

    console.log(`   Aggregated ${sourcesIncludedCount} source ${analysisFileType}(s) (${combinedLength} chars) for final analysis.`);
    return combinedAnalysisInput;
}


/** Generates the source-specific newsletter digest using Gemini */
async function generateSourceNewsletterDigest(aggregatedSourceContent, outputPath, sourceName, geminiModelOverride = null) {
    const prompt = `You are a neutral, objective news analyst focusing *only* on the news from the source "${sourceName}". Synthesize the provided articles from this source into a concise daily digest.

Format Requirements:
1.  **Derive Headlines:** Internally determine a concise, accurate headline for each article based *only* on its provided content.
2.  **Source Summary:** Start with a brief (1-3 sentence) objective summary of the main news reported *by this source*.
3.  **Key Story Summaries:** Create sections for major themes (e.g., ## Politics, ## Business). Under each theme, provide concise, factual summaries (2-4 sentences) of the relevant articles from *this source*. Use the headlines you derived.
4.  **Key Facts Reported (by this source):** List 2-4 bullet points of verifiable facts under \`## Key Facts Reported\`.
5.  **Source Narrative Analysis:** Briefly (1-3 sentences) discuss any notable narrative or perspective evident *in this source's reporting* under \`## Narrative Analysis\`.

**Input Articles from ${sourceName}:**
${aggregatedSourceContent}`;

    const modelToUse = geminiModelOverride || config.gemini.model;
    console.log(`🤖 Asking Gemini (${modelToUse}) to generate SOURCE digest for ${sourceName}...`);
    try {
        const newsletterContent = await ask_gemini(prompt, { model: modelToUse, temperature: config.gemini.temperature });
        if (!newsletterContent) { console.error(`❌ Gemini (${modelToUse}) returned no response for ${sourceName} digest.`); return false; }
        const cleanedNewsletter = newsletterContent.replace(/```markdown\n?/, '').replace(/```$/, '').trim();
        await fs.writeFile(outputPath, cleanedNewsletter, 'utf8');
        console.log(`✅📰 Source digest saved: ${path.basename(outputPath)}`);
        return true;
    } catch (error) { console.error(`❌ Error generating ${sourceName} digest with Gemini (${modelToUse}): ${error.message}`); return false; }
}


/** Generates the source-specific analytical essay using Gemini */
async function generateSourceAnalysisEssay(aggregatedSourceContent, outputPath, sourceName, geminiModelOverride = null) {
    const prompt = `You are a sophisticated news analyst and critical thinker. Based *only* on the articles provided from the source "${sourceName}", write a thoughtful analytical essay (approx 300-600 words). Focus *exclusively* on the themes, events, and narratives presented *by this source*.

Your essay should:
1.  **Introduction:** Identify the most prominent theme(s) or event(s) reported *by this source* and state your essay's analytical focus regarding this source's coverage.
2.  **Synthesis and Analysis:** Weave together information *from this source's articles* to analyze the main themes. Discuss narratives or implications *within this source's reporting*. **Derive and integrate concise headlines** naturally in your prose.
3.  **Critical Reflection:** Explore complexities or raise insightful questions prompted *by this source's specific articles*. Ground your interpretation *only* in the provided text.
4.  **Conclusion:** Offer a concluding thought synthesizing your analysis of the news *as depicted by this source*.

**Maintain an analytical and formal tone. Do not inject external facts or compare with other sources.**

**Source Articles from ${sourceName}:**
${aggregatedSourceContent}`;

    const modelToUse = geminiModelOverride || config.gemini.model;
    console.log(`✍️ Asking Gemini (${modelToUse}) to generate SOURCE essay for ${sourceName}...`);
    try {
      const essayContent = await ask_gemini(prompt, { model: modelToUse, temperature: config.gemini.temperature });
      if (!essayContent) { console.error(`❌ Gemini (${modelToUse}) returned no response for ${sourceName} essay.`); return false; }
      const cleanedEssay = essayContent.replace(/```markdown\n?/, '').replace(/```$/, '').trim();
      await fs.writeFile(outputPath, cleanedEssay, 'utf8');
      console.log(`✅✍️ Source analytical essay saved: ${path.basename(outputPath)}`);
      return true;
    } catch (error) { console.error(`❌ Error generating ${sourceName} essay with Gemini (${modelToUse}): ${error.message}`); return false; }
}


/** Generates the FINAL COMBINED newsletter digest using Gemini from SOURCE digests */
async function generateCombinedNewsletterDigest(aggregatedDigests, outputPath, geminiModelOverride = null) {
    const prompt = `You are a meta-analyst synthesizing daily news digests from multiple sources identified below (delimited by '--- SOURCE START ---' and '--- SOURCE END ---'). Combine these source-specific digests into a single, comprehensive overview of the day's news.

**Task:** Create a **Combined Daily Digest**.

**Instructions:**
1.  **Overall Summary:** Start with a concise (3-5 sentence) summary synthesizing the most important events reported across *all* sources. Highlight key areas of agreement or significant divergence in coverage focus or reported details, explicitly mentioning source names where differences occur.
2.  **Thematic Summaries:** Organize by major themes (e.g., ## Politics, ## World News, ## Business). Under each theme, synthesize the information presented in the source digests. **Crucially, note which sources covered specific aspects of a story or if key information/events were present in one source's digest but omitted in another's.** Attribute differing facts or focuses to their respective sources (e.g., "While [Source A]'s digest focused on X, [Source B]'s digest emphasized Y...").
3.  **Contrasting Perspectives/Narratives:** Include a section \`## Differing Perspectives\` briefly summarizing distinct angles or narratives identified in the source digests regarding 1-2 major events. Attribute perspectives to their sources.
4.  **Key Facts Across Sources:** List 3-5 key facts under \`## Key Facts Reported Across Sources\`, noting if a fact was reported by multiple source digests or appeared unique to one.

**Input Source Digests:**
${aggregatedDigests}`;

    const modelToUse = geminiModelOverride || config.gemini.model;
    console.log(`🤖 Asking Gemini (${modelToUse}) to generate the FINAL COMBINED newsletter digest...`);
    try {
        const newsletterContent = await ask_gemini(prompt, { model: modelToUse, temperature: config.gemini.temperature });
        if (!newsletterContent) { console.error(`❌ Gemini (${modelToUse}) returned no response for COMBINED digest.`); return; }
        const cleanedNewsletter = newsletterContent.replace(/```markdown\n?/, '').replace(/```$/, '').trim();
        await fs.writeFile(outputPath, cleanedNewsletter, 'utf8');
        console.log(`✅📰 COMBINED digest saved: ${path.basename(outputPath)}`);
    } catch (error) { console.error(`❌ Error generating COMBINED digest with Gemini (${modelToUse}): ${error.message}`); }
}

/** Generates the FINAL COMBINED analytical essay using Gemini from SOURCE essays */
async function generateCombinedAnalysisEssay(aggregatedEssays, outputPath, geminiModelOverride = null) {
     const prompt = `You are a sophisticated media critic and news analyst with a nuanced writing style. Based *only* on the collection of source-specific analytical essays provided below (delimited by '--- SOURCE START ---' and '--- SOURCE END ---'), write a *new*, overarching analytical essay (approximately 700-1200 words). This final essay should critically examine the collective news landscape, media narratives, and potential biases as revealed by comparing and contrasting the different source analyses.

**Your Final Essay Should:**
1.  **Introduction:** Identify the dominant meta-themes, key points of consensus, and significant areas of divergence or conflict revealed by comparing the *source essays*. State the central argument of your meta-analysis regarding the day's news coverage and its interpretation.
2.  **Comparative Narrative & Perspective Analysis:**
    *   Synthesize the key analytical points made *within* the individual source essays.
    *   **Explicitly compare and contrast** the narratives, perspectives, angles, depth of analysis, and potential biases identified *in the source essays themselves*. How did different sources (as reflected in their essays) frame the same events? What was emphasized? What might have been omitted or downplayed according to the source essays? Use comparative language (e.g., "In contrast to [Source A]'s focus on..., the essay from [Source B] highlights...", "Both [Source C] and [Source D] analyses pointed to..., but differed on its cause...").
    *   Discuss how the selection and framing of stories, as interpreted by the source essays, contribute to different overall pictures or understandings of the day's events.
3.  **Critical Meta-Reflection:**
    *   Offer insights into the broader media landscape, potential systemic biases, or the nature of news interpretation based on the *variations observed between the source essays*.
    *   Reflect on the complexities, ambiguities, or unanswered questions that persist even after considering these multiple analytical viewpoints.
    *   Raise deeper questions about media framing, narrative construction, ideological leanings (as suggested *by the source essays' analyses*), or public understanding prompted by the collection.
4.  **Conclusion:** Provide a concluding thought that synthesizes your meta-analysis of the news coverage and its interpretation, reflecting on the overall picture presented by the combined source essays.

**Maintain a critical, analytical, and sophisticated tone. Your focus is on analyzing the *analyses* provided in the input, drawing connections and contrasts between them.** Do not simply repeat the content of the source essays; build upon them.

**Input Source Essays:**
${aggregatedEssays}`;

    const modelToUse = geminiModelOverride || config.gemini.model;
    console.log(`✍️ Asking Gemini (${modelToUse}) to generate the FINAL COMBINED analytical essay...`);
    try {
      const essayContent = await ask_gemini(prompt, { model: modelToUse, temperature: config.gemini.temperature }); // Use generation temp
      if (!essayContent) { console.error(`❌ Gemini (${modelToUse}) returned no response for COMBINED essay.`); return; }
      const cleanedEssay = essayContent.replace(/```markdown\n?/, '').replace(/```$/, '').trim();
      await fs.writeFile(outputPath, cleanedEssay, 'utf8');
      console.log(`✅✍️ COMBINED analytical essay saved: ${path.basename(outputPath)}`);
    } catch (error) { console.error(`❌ Error generating COMBINED essay with Gemini (${modelToUse}): ${error.message}`); }
}


// --- Function for Re-running Specific Analysis Types ---
/**
 * Reads relevant files from a directory and generates specific analysis types.
 * @param {string} targetDirPath - Path to the source-specific date directory OR the base date directory.
 * @param {'source-digest'|'source-essay'|'combined-digest'|'combined-essay'|'extract-only'} analysisTask - Specific task to run.
 * @param {string|null} geminiModelOverride - Optional Gemini model name.
 */
async function rerunSpecificAnalysis(targetDirPath, analysisTask, geminiModelOverride = null) {
    console.log(`\n--- Rerunning Task: ${analysisTask} for Directory/Date: ${targetDirPath} ---`);
    if (geminiModelOverride) console.log(`   Using specified Gemini model: ${geminiModelOverride}`);

    const datePart = path.basename(targetDirPath.includes(path.sep + 'parsed_text') || targetDirPath.includes(path.sep + 'raw_html') ? path.dirname(path.dirname(targetDirPath)) : targetDirPath);
    const modelSuffix = geminiModelOverride ? geminiModelOverride.replace(/[^a-zA-Z0-9]/g, '_') : 'default';

    try {
        if (analysisTask === 'extract-only') {
             // Logic for extract-only
             const rawHtmlDir = path.join(targetDirPath, 'raw_html');
             const parsedTextDir = path.join(targetDirPath, 'parsed_text');
             await fs.access(rawHtmlDir);
             await fs.mkdir(parsedTextDir, { recursive: true });
             const htmlFiles = await fs.readdir(rawHtmlDir);
             const htmlFileNames = htmlFiles.filter(f => f.endsWith('.html'));
             if (htmlFileNames.length === 0) { console.log(`🚫 No raw HTML files found in ${rawHtmlDir}.`); return; }

             console.log(`   Found ${htmlFileNames.length} raw HTML files to process.`);
             const extractionDelay = 10000; let extractionCounter = 0; let successCounter = 0;
             for (const htmlFileName of htmlFileNames) { /* ... extraction loop ... */
                extractionCounter++;
                const rawHtmlFilePath = path.join(rawHtmlDir, htmlFileName);
                const baseName = path.basename(htmlFileName, '.html');
                const parsedTextFilePath = path.join(parsedTextDir, `${baseName}.txt`);
                console.log(`   Extracting text ${extractionCounter}/${htmlFileNames.length}: ${htmlFileName}`);
                const extractedText = await extractTextFromHtml(rawHtmlFilePath, parsedTextFilePath); // Uses Gemini with retries
                if (extractedText !== null) successCounter++;
                else console.warn(`   Extraction failed for ${htmlFileName} after retries.`);
                if (extractionCounter < htmlFileNames.length) {
                    console.log(`   Waiting ${extractionDelay / 1000}s...`);
                    await new Promise(resolve => setTimeout(resolve, extractionDelay));
                }
             }
             console.log(`\n--- Extraction Only Complete for ${targetDirPath} ---`);
             console.log(`   Successfully extracted text for ${successCounter}/${htmlFileNames.length} files.`);

        } else if (analysisTask === 'source-digest' || analysisTask === 'source-essay') {
            // Logic for source-specific analysis rerun
            const parsedTextDir = path.join(targetDirPath, 'parsed_text');
            const sourceName = path.basename(targetDirPath);
            await fs.access(parsedTextDir);
            const textFiles = await fs.readdir(parsedTextDir);
            const txtFileNames = textFiles.filter(f => f.endsWith('.txt'));
            if (txtFileNames.length === 0) { console.log(`🚫 No parsed text files in ${parsedTextDir}.`); return; }

            console.log(`   Found ${txtFileNames.length} parsed text files for source ${sourceName}.`);
            const articlesData = [];
            for (const txtFileName of txtFileNames) { /* ... read files into articlesData ... */
                const txtFilePath = path.join(parsedTextDir, txtFileName);
                try {
                    const textContent = await fs.readFile(txtFilePath, 'utf8');
                    articlesData.push({ url: `(source_file: ${txtFileName})`, text: textContent, rawHtmlPath: null });
                } catch (readError) { console.warn(`   ⚠️ Skipping: Could not read "${txtFileName}". ${readError.message}`); }
            }

            if (articlesData.length > 0) {
                const combinedSourceContent = await aggregateArticleDataForSource(articlesData);
                if (!combinedSourceContent) { console.error("❌ Failed aggregation for source rerun."); return; }

                if (analysisTask === 'source-digest') {
                    const digestFileName = `digest_${sourceName}_${datePart}_${modelSuffix}_${Date.now()}.md`;
                    await generateSourceNewsletterDigest(combinedSourceContent, path.join(targetDirPath, digestFileName), sourceName, geminiModelOverride);
                } else { // source-essay
                    const essayFileName = `essay_${sourceName}_${datePart}_${modelSuffix}_${Date.now()}.md`;
                    await generateSourceAnalysisEssay(combinedSourceContent, path.join(targetDirPath, essayFileName), sourceName, geminiModelOverride);
                }
            } else { console.log("🚫 No valid article data loaded for source re-analysis."); }

        } else if (analysisTask === 'combined-digest' || analysisTask === 'combined-essay') {
            // Logic for combined analysis rerun (targetDirPath is the base date directory)
            const baseDateDir = targetDirPath;
            const sourceDirs = await getSourcesForDate(datePart);
            if (sourceDirs.length === 0) { console.log(`🚫 No source directories found in ${baseDateDir}.`); return; }

            const aggregationFileType = analysisTask === 'combined-digest' ? 'digest' : 'essay';
            const processedSourcesData = sourceDirs.map(name => ({ sourceName: name, runDir: path.join(baseDateDir, name) }));

            const combinedInput = await aggregateAnalysisFiles(processedSourcesData, aggregationFileType);

            if (combinedInput) {
                if (analysisTask === 'combined-digest') {
                    const digestFileName = `daily_digest_${datePart}_${modelSuffix}_${Date.now()}.md`; // New timestamp
                    await generateCombinedNewsletterDigest(combinedInput, path.join(baseDateDir, digestFileName), geminiModelOverride);
                } else { // combined-essay
                    const essayFileName = `analysis_essay_${datePart}_${modelSuffix}_${Date.now()}.md`; // New timestamp
                    await generateCombinedAnalysisEssay(combinedInput, path.join(baseDateDir, essayFileName), geminiModelOverride);
                }
            } else { console.log(`🚫 No source ${aggregationFileType} files could be aggregated.`); }
        } else {
            console.error(`❌ Unknown analysis task: ${analysisTask}`);
        }
    } catch (error) {
        console.error(`❌ Error during rerun task '${analysisTask}' for ${targetDirPath}: ${error.message}`);
        if (error.code === 'ENOENT') {
            console.error(`   Ensure the directory exists and contains required subdirectories ('raw_html' for extract, 'parsed_text' for source analysis, source subdirs for combined analysis).`);
        }
    }
     console.log(`\n--- Rerun Task (${analysisTask}) Complete ---`);
}


// --- Main Execution Logic ---
async function main() {
    // --- Command Line Argument Parsing ---
    const argv = yargs(hideBin(process.argv))
        .option('rerun-task', { // Renamed from analyze-only/extract-only
            alias: 'r',
            type: 'string',
            choices: ['extract-only', 'source-digest', 'source-essay', 'combined-digest', 'combined-essay'],
            description: "Run only a specific task on existing data. Requires -d.\n" +
                         "  'extract-only': Re-run text extraction.\n" +
                         "  'source-digest'/'source-essay': Re-run source-specific analysis.\n" +
                         "  'combined-digest'/'combined-essay': Re-run final combined analysis.",
        })
        .option('directory', {
            alias: 'd',
            type: 'string',
            description: "Path for --rerun-task:\n" +
                         "  - For 'extract-only', 'source-*': Use source-specific date dir (e.g., ./data/YYYY-MM-DD/source_name).\n" +
                         "  - For 'combined-*': Use base date dir (e.g., ./data/YYYY-MM-DD).",
            // Required only if -r is used (checked below)
        })
        .option('model', {
            alias: 'm',
            type: 'string',
            description: `Override Gemini model for analysis generation (Default: ${config.gemini.model}). Applies to relevant analysis/rerun tasks.`
        })
        // Type flag is removed as it's now part of rerun-task or implicitly 'both' for full run
        // .option('type', { ... })
        .check((argv) => { // Custom validation
             if (argv.rerunTask && !argv.directory) {
                 throw new Error("Error: --directory (-d) argument is required when using --rerun-task (-r).");
             }
             return true;
         })
        .help()
        .alias('help', 'h')
        .argv;

    console.log("--- Starting Daily News Workflow (Gemini Only - Source & Combined Analysis) ---");

    if (!validateConfig()) { process.exit(1); }

    // --- Handle Rerun Mode ---
    if (argv.rerunTask) {
        const potentialPath = path.resolve(argv.directory);
        console.log(`▶️ Rerun Task Mode: ${argv.rerunTask}`);
        console.log(`   Target directory/date: ${potentialPath}`);
        if (argv.model) console.log(`   Using Model: ${argv.model}`);

        try {
            const stats = await fs.stat(potentialPath);
            if (!stats.isDirectory()) throw new Error("Path is not a directory.");
            const resolvedBaseDir = path.resolve(config.scraper.outputBaseDir);

            // Validate path structure based on task
            if (argv.rerunTask === 'extract-only' || argv.rerunTask.startsWith('source-')) {
                 if (!potentialPath.startsWith(resolvedBaseDir) || potentialPath === resolvedBaseDir || path.basename(path.dirname(potentialPath)).length !== 10) { // Check if parent looks like YYYY-MM-DD
                     throw new Error(`For '${argv.rerunTask}', directory must be a source-specific date path within ${resolvedBaseDir} (e.g., .../YYYY-MM-DD/source_name)`);
                 }
            } else { // combined-digest or combined-essay
                 if (!potentialPath.startsWith(resolvedBaseDir) || path.basename(potentialPath).length !== 10 || !dayjs(path.basename(potentialPath), 'YYYY-MM-DD', true).isValid()) {
                     throw new Error(`For '${argv.rerunTask}', directory must be a base date path within ${resolvedBaseDir} (e.g., .../YYYY-MM-DD)`);
                 }
            }

            // Call the appropriate rerun function
            await rerunSpecificAnalysis(potentialPath, argv.rerunTask, argv.model || null);

        } catch (error) {
             if (error.code === 'ENOENT') { console.error(`❌ Error: Directory "${potentialPath}" does not exist or required subdirectory missing.`); }
             else { console.error(`❌ Error processing directory "${potentialPath}": ${error.message}`); }
        }
        console.log("\n--- Rerun Task Complete ---");
        return; // Exit
    }

    // --- Full Scrape and Analysis Workflow ---
    console.log("▶️ Running Full Scrape and Analysis Workflow...");
    console.log(`   (Will generate both digest and essay for sources and combined)`); // Default is now always both for full run
    if (argv.model) console.log(`   (Using specified model for all analysis: ${argv.model})`);

    const dateFolder = getCurrentDateFolder();
    const sourceUrlsFromFile = await readSourceUrls();
    const allProcessedSourcesData = []; // Stores { sourceName: string, runDir: string } for final aggregation

    const interScrapeDelay = config.processingDelayMs / 2 > 1000 ? config.processingDelayMs / 2 : 1000;
    const interExtractionDelay = 10000; // 10s

    let baseDateDir = path.join(config.scraper.outputBaseDir, dateFolder); // Initialize baseDateDir

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

        const setupResult = await setupDirectories(dateFolder, sourceName);
        const { runDir, rawHtmlDir, parsedTextDir } = setupResult;
        baseDateDir = setupResult.baseDateDir; // Update in case it was the first run

        console.log("\n--- Step 1: Scraping Source & Extracting Article URLs ---");
        sourceHtmlContent = await scrapeAndGetContent(sourceUrl);
        if (!sourceHtmlContent) { console.warn(`   Skipping ${sourceName}: source scrape error.`); continue; }

        const articleUrls = await extractArticleUrls(sourceHtmlContent, sourceUrl);
        if (articleUrls.length === 0) { console.log(`   No likely article URLs found by Gemini for ${sourceName}.`); continue; }

        console.log(`\n--- Step 2: Scraping ${articleUrls.length} Articles for ${sourceName} ---`);
        const scrapedArticlePaths = [];
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
                 console.log(`   Waiting ${interScrapeDelay / 1000}s...`);
                 await new Promise(resolve => setTimeout(resolve, interScrapeDelay));
            }
        }

        if (scrapedArticlePaths.length === 0) { console.log(`🚫 No articles successfully scraped for ${sourceName}.`); continue; }

        console.log(`\n--- Step 3: Extracting Verbatim Text from ${scrapedArticlePaths.length} Articles (${sourceName}) ---`);
        let extractionCounter = 0;
        const sourceArticlesData = []; // Holds data for THIS source only
        for (const article of scrapedArticlePaths) {
            extractionCounter++;
            console.log(`   Extracting text ${extractionCounter}/${scrapedArticlePaths.length}: ${path.basename(article.rawHtmlPath)}`);
            const baseName = path.basename(article.rawHtmlPath, '.html');
            const parsedTextFilePath = path.join(parsedTextDir, `${baseName}.txt`);
            const extractedText = await extractTextFromHtml(article.rawHtmlPath, parsedTextFilePath);
            if (extractedText !== null) {
                sourceArticlesData.push({ url: article.url, text: extractedText, rawHtmlPath: article.rawHtmlPath, source: sourceName });
            } else { console.warn(`   Skipping article ${baseName} due to extraction failure.`); }
            if (extractionCounter < scrapedArticlePaths.length) {
                 console.log(`   Waiting ${interExtractionDelay / 1000}s...`);
                 await new Promise(resolve => setTimeout(resolve, interExtractionDelay));
            }
        }

        // --- Step 3.5: Generate SOURCE-SPECIFIC Analysis ---
        if (sourceArticlesData.length > 0) {
            console.log(`\n--- Step 3.5: Generating Analysis for ${sourceName} (${sourceArticlesData.length} articles) ---`);
            const modelUsedSuffix = argv.model ? argv.model.replace(/[^a-zA-Z0-9]/g,'_') : 'default';
            const combinedSourceContent = await aggregateArticleDataForSource(sourceArticlesData);

            let sourceAnalysisAttempted = false;
            if (combinedSourceContent) {
                 // Always attempt both digest and essay for the source during a full run
                const digestFileName = `digest_${sourceName}_${dateFolder}_${modelUsedSuffix}.md`;
                const digestOutputPath = path.join(runDir, digestFileName);
                const essayFileName = `essay_${sourceName}_${dateFolder}_${modelUsedSuffix}.md`;
                const essayOutputPath = path.join(runDir, essayFileName);

                const digestSuccess = await generateSourceNewsletterDigest(combinedSourceContent, digestOutputPath, sourceName, argv.model || null);
                const essaySuccess = await generateSourceAnalysisEssay(combinedSourceContent, essayOutputPath, sourceName, argv.model || null);

                if(digestSuccess || essaySuccess) {
                     sourceAnalysisAttempted = true; // Mark as attempted if at least one succeeded
                }
            } else { console.log(`🚫 Aggregated content was empty for ${sourceName}.`); }

             if (sourceAnalysisAttempted) {
                 allProcessedSourcesData.push({ sourceName: sourceName, runDir: runDir });
             } else {
                  console.log(`\n🚫 No source-specific analysis generated for ${sourceName}.`);
             }
        } else {
            console.log(`\n🚫 No articles processed successfully for ${sourceName}.`);
        }

    } // End source URL loop

    // --- Step 4: Generate the final COMBINED outputs based on SOURCE digests/essays ---
    if (allProcessedSourcesData.length > 0) {
        console.log(`\n--- Step 4: Generating Final COMBINED Analysis from ${allProcessedSourcesData.length} Sources ---`);
        await fs.mkdir(baseDateDir, { recursive: true });
        const modelUsedSuffix = argv.model ? argv.model.replace(/[^a-zA-Z0-9]/g,'_') : 'default';

        // Always generate both combined types in a full run
        const combinedDigestInput = await aggregateAnalysisFiles(allProcessedSourcesData, 'digest');
        if (combinedDigestInput) {
            const digestFileName = `daily_digest_${dateFolder}_${modelUsedSuffix}.md`;
            const digestOutputPath = path.join(baseDateDir, digestFileName);
            await generateCombinedNewsletterDigest(combinedDigestInput, digestOutputPath, argv.model || null);
        } else { console.warn("🚫 Could not aggregate source digests for final combined digest."); }

        const combinedEssayInput = await aggregateAnalysisFiles(allProcessedSourcesData, 'essay');
        if (combinedEssayInput) {
            const essayFileName = `analysis_essay_${dateFolder}_${modelUsedSuffix}.md`;
            const essayOutputPath = path.join(baseDateDir, essayFileName);
            await generateCombinedAnalysisEssay(combinedEssayInput, essayOutputPath, argv.model || null);
        } else { console.warn("🚫 Could not aggregate source essays for final combined essay."); }

    } else {
        console.log("\n🚫 No sources processed successfully with analysis generation. No final combined analysis generated.");
    }

    console.log("\n--- Workflow Complete ---");
}

// Run the main function
main().catch(error => {
  console.error("💥 Unhandled error in main workflow:", error);
  process.exit(1);
});
