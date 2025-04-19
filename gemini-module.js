// gemini-module.js
const { GoogleGenAI } = require('@google/genai'); // Use the correct class name from your reference
const { config } = require('./config');

/**
 * Ask a question to the Gemini model and get the response
 * @param {string} question - The question to ask
 * @param {Object} options - Optional parameters
 * @param {string} options.apiKey - Override the default API key
 * @param {string} options.model - Override the default model
 * @param {number} options.temperature - Override the default temperature
 * @returns {Promise<string>} - The response from the model
 */
async function ask_gemini(question, options = {}) {
  try {
    // Merge default config with provided options
    const apiKey = options.apiKey || config.gemini.apiKey;
    const model = options.model || config.gemini.model;
    const temperature = options.temperature !== undefined ? options.temperature : config.gemini.temperature;
    
    if (!apiKey) {
      throw new Error("Gemini API key is required");
    }
    
    // Initialize Gemini client using the class from your reference code
    const ai = new GoogleGenAI({
      apiKey: apiKey,
    });
    
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
    
    // Make the API call using the method from your reference code
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
    console.error(`Error in ask_gemini: ${error.message}`);
    throw error;
  }
}

module.exports = { ask_gemini };  
