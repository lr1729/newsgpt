// gemini-module.js
const { GoogleGenAI } = require('@google/genai');
const { config } = require('./config');

/**
 * Ask a question to the Gemini model with retry logic for rate limiting
 * @param {string} question - The question to ask
 * @param {Object} options - Optional parameters
 * @param {string} options.apiKey - Override the default API key
 * @param {string} options.model - Override the default model
 * @param {number} options.temperature - Override the default temperature
 * @param {number} options.maxRetries - Maximum number of retries (default: 5)
 * @param {number} options.initialBackoff - Initial backoff time in ms (default: 1000)
 * @returns {Promise<string>} - The response from the model
 */
async function ask_gemini(question, options = {}) {
  // Merge default config with provided options
  const apiKey = options.apiKey || config.gemini.apiKey;
  const model = options.model || config.gemini.model;
  const temperature = options.temperature !== undefined ? options.temperature : config.gemini.temperature;
  const maxRetries = options.maxRetries || 100;
  const initialBackoff = options.initialBackoff || 1000;
  
  if (!apiKey) {
    throw new Error("Gemini API key is required");
  }
  
  // Initialize Gemini client
  const ai = new GoogleGenAI({
    apiKey: apiKey,
  });
  
  let retries = 0;
  
  while (true) {
    try {
      console.log(`Asking Gemini (${model}): "${question.substring(0, 50)}${question.length > 50 ? '...' : ''}"`);
      
      // Configure generation parameters
      const genConfig = {
        responseMimeType: 'text/plain',
        temperature: temperature,
      };
      
      // Create simplified contents array with just the user question
      const contents = [
        {
          role: 'user',
          parts: [{ text: question }],
        }
      ];
      
      // Make the API call
      const response = await ai.models.generateContentStream({
        model,
        config: genConfig,
        contents,
      });
      
      // Collect all chunks into a single response
      let fullResponse = '';
      for await (const chunk of response) {
        fullResponse += chunk.text || '';
      }
      
      return fullResponse;
    } catch (error) {
      // Check if it's a rate limit error (429) and we haven't exceeded max retries
      if (error.message.includes("429") && retries < maxRetries) {
        retries++;
        const backoffTime = initialBackoff * retries; // Linear backoff
        console.log(`Rate limit (429) encountered. Retry ${retries}/${maxRetries} after ${backoffTime}ms backoff`);
        
        // Wait for the calculated backoff time
        await new Promise(resolve => setTimeout(resolve, backoffTime));
      } else {
        // Either it's not a rate limit error or we've exhausted retries
        console.error(`Error in ask_gemini: ${error.message}`);
        throw error;
      }
    }
  }
}

module.exports = { ask_gemini };
