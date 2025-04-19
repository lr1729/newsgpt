// config.js
require('dotenv').config();
const path = require('path');
const fs = require('fs'); // Need fs for path validation

/**
 * Configuration object for the application
 */
const config = {
  // ---- Source File ----
  // We'll read URLs from this file. For the NYT sample,
  // we know it's HTML content we need to fetch first.
  sourceListFile: 'urls.txt',
  sourceMapping: { // Map hostname/identifier to a friendly name for folders
    'static.nytimes.com': 'nytimes_email', // Special case for the sample
    'www.nytimes.com': 'nytimes'
    // Add mappings for other sources later, e.g., 'www.wsj.com': 'wsj'
  },

  // ---- API Configurations ----
  cerebras: {
    apiKey: process.env.CEREBRAS_API_KEY,
    // Using a generally available small model for extraction tasks
    model: process.env.CEREBRAS_MODEL || 'llama-3-8b-instruct',
    temperature: parseFloat(process.env.CEREBRAS_TEMPERATURE || '0.1'), // Low temp for extraction
    maxTokens: parseInt(process.env.CEREBRAS_MAX_TOKENS || '2048', 10)
  },
  gemini: {
    apiKey: process.env.GEMINI_API_KEY,
    // Using a modern, capable model for generation
    model: process.env.GEMINI_MODEL || 'gemini-1.5-flash-latest',
    temperature: parseFloat(process.env.GEMINI_TEMPERATURE || '0.6'), // Higher for creative generation
    maxOutputTokens: 8192 // Gemini specific setting (may vary based on SDK usage)
  },

  // ---- Web Scraper Configuration ----
  scraper: {
    // Use the path you provided
    extensionPath: process.env.EXTENSION_PATH || 'C:/Users/Chris/Desktop/bypass-paywalls-chrome-clean-main',
    outputBaseDir: process.env.OUTPUT_BASE_DIR || 'daily_news_data',
    // Subdirectory names (raw_html, parsed_text) and date/source folders will be generated
  },

  // --- Other Settings ---
  processingDelayMs: 3000, // Delay between scraping/processing steps (milliseconds)
  // Increased safeguard, Gemini 1.5 can handle large contexts, but chunking might be needed for huge inputs
  maxArticleContentLengthForGemini: 1800000
};

// Validate required configuration
function validateConfig() {
  const missingKeys = [];
  if (!config.gemini.apiKey) missingKeys.push('GEMINI_API_KEY'); // Gemini is essential for final step
  // Make Cerebras optional for initial URL extraction if needed later, but required for text parsing
  if (!config.cerebras.apiKey) missingKeys.push('CEREBRAS_API_KEY (needed for text extraction)');
  if (!config.scraper.extensionPath || !fs.existsSync(config.scraper.extensionPath)) {
      missingKeys.push('EXTENSION_PATH (must be a valid path to the extension)');
  }
  if (!fs.existsSync(config.sourceListFile)) {
     missingKeys.push(`Source list file (expected at ${config.sourceListFile})`);
  }

  if (missingKeys.length > 0) {
    console.error('\n❌ Missing or invalid required configuration:');
    missingKeys.forEach(key => console.error(`   - ${key}`));
    console.error('\nPlease set these values correctly in your .env file or config.js and ensure files/paths exist.');
    return false;
  }

  // Specific check for BPC path ending
  if (!config.scraper.extensionPath.endsWith('bypass-paywalls-chrome-clean-main')) {
      console.warn(`⚠️ Warning: EXTENSION_PATH (${config.scraper.extensionPath}) does not end with 'bypass-paywalls-chrome-clean-main'. Ensure this is the correct unpacked extension folder.`);
  }


  return true;
}

module.exports = {
  config,
  validateConfig
};
