// config.js
require('dotenv').config(); // Load variables from .env file
const path = require('path');
const fs = require('fs');

/**
 * Configuration object for the application
 */
const config = {
  // ---- Source File ----
  // Reads URLs from this file, one per line. '#' starts a comment.
  sourceListFile: 'urls.txt', // Make sure this file exists in your project root
  sourceMapping: {
    // Map hostname/identifier to a friendly name for folders
    'static.nytimes.com': 'nytimes_email', // Special case for the NYT sample email HTML
    'www.nytimes.com': 'nytimes',
    // Add mappings for other sources here as needed
    // 'www.wsj.com': 'wsj',
    // 'www.theguardian.com': 'guardian'
  },

  // ---- API Configurations ----
  // Cerebras is now optional for the main workflow if using the Gemini-only main.js
  cerebras: {
    apiKey: process.env.CEREBRAS_API_KEY, // Reads from .env
    model: process.env.CEREBRAS_MODEL || 'llama-3-8b-instruct', // Use model from .env or default
    temperature: parseFloat(process.env.CEREBRAS_TEMPERATURE || '0.1'),
    maxTokens: parseInt(process.env.CEREBRAS_MAX_TOKENS || '8192', 10) // Use value from .env or default
  },
  gemini: {
    apiKey: process.env.GEMINI_API_KEY, // Reads from .env
    model: process.env.GEMINI_MODEL || 'gemini-2.5-flash-preview-04-17',
    temperature: parseFloat(process.env.GEMINI_TEMPERATURE || '0.6'), // Use .env value or default for generation
    maxOutputTokens: 8192 // Standard max for Gemini models
  },

  // ---- Web Scraper Configuration ----
  scraper: {
    // Path to the Bypass Paywalls extension (reads from .env first)
    bypassPaywallsExtensionPath: process.env.EXTENSION_PATH || '/home/lr/Documents/programming/news/bypass-paywalls-chrome-clean-master', // Uses EXTENSION_PATH from .env

    // Path to the uBlock Origin Lite extension (reads from .env or uses default)
    ublockLiteExtensionPath: process.env.UBLOCK_LITE_EXTENSION_PATH || '/home/lr/Documents/programming/news/uBOLite', // Add this line to .env if you want to override

    // Base output directory (reads from .env or uses default)
    outputBaseDir: process.env.OUTPUT_DIR || 'daily_news_data', // Uses OUTPUT_DIR from .env
  },

  // --- Other Settings ---
  processingDelayMs: 3000, // Delay between scraping/processing steps (milliseconds)
  maxArticleContentLengthForGemini: 1800000 // Safeguard token limit for combined content sent to Gemini
};

// Validate required configuration
function validateConfig() {
  const missingKeys = [];

  // Gemini Key is essential
  if (!config.gemini.apiKey) missingKeys.push('GEMINI_API_KEY');

  // Check if Extension Paths exist
  if (!config.scraper.bypassPaywallsExtensionPath || !fs.existsSync(config.scraper.bypassPaywallsExtensionPath)) {
      missingKeys.push(`BYPASS_PAYWALLS_EXTENSION_PATH (from env: EXTENSION_PATH = "${process.env.EXTENSION_PATH}"). Path must exist.`);
  }
  if (!config.scraper.ublockLiteExtensionPath || !fs.existsSync(config.scraper.ublockLiteExtensionPath)) {
      missingKeys.push(`UBLOCK_LITE_EXTENSION_PATH ("${config.scraper.ublockLiteExtensionPath}"). Path must exist. Set UBLOCK_LITE_EXTENSION_PATH in .env to override default.`);
  }

  // Check if Source List file exists
  if (!fs.existsSync(config.sourceListFile)) {
     missingKeys.push(`Source list file (expected at ${config.sourceListFile})`);
  }

  // Optional: Add back Cerebras key check if you intend to use it
  // if (!config.cerebras.apiKey) missingKeys.push('CEREBRAS_API_KEY');


  if (missingKeys.length > 0) {
    console.error('\n❌ Missing or invalid required configuration:');
    missingKeys.forEach(key => console.error(`   - ${key}`));
    console.error('\nPlease ensure the necessary environment variables are set in your .env file (or system environment) and that all specified paths/files exist.');
    return false;
  }

  // Optional: Warning about BPC naming (can be removed if your path is correct)
  if (!config.scraper.bypassPaywallsExtensionPath.endsWith('bypass-paywalls-chrome-clean-main') && !config.scraper.bypassPaywallsExtensionPath.endsWith('bypass-paywalls-chrome-clean-master') ) {
      console.warn(`⚠️ Warning: BYPASS_PAYWALLS_EXTENSION_PATH (${config.scraper.bypassPaywallsExtensionPath}) doesn't end with a standard BPC folder name. Ensure this is the correct unpacked extension folder.`);
  }

  return true;
}

module.exports = {
  config,
  validateConfig
};
