// cerebras-module.js
const Cerebras = require('@cerebras/cerebras_cloud_sdk');
const { config } = require('./config');

/**
 * Ask a question to the Cerebras model and get the response
 * @param {string} question - The question to ask
 * @param {Object} options - Optional parameters
 * @param {string} options.apiKey - Override the default API key
 * @param {string} options.model - Override the default model
 * @param {number} options.temperature - Override the default temperature
 * @param {number} options.maxTokens - Override the default max tokens
 * @returns {Promise<string>} - The response from the model
 */
async function ask_cerebras(question, options = {}) {
  try {
    // Merge default config with provided options
    const apiKey = options.apiKey || config.cerebras.apiKey;
    const model = options.model || config.cerebras.model;
    const temperature = options.temperature !== undefined ? options.temperature : config.cerebras.temperature;
    const maxTokens = options.maxTokens || config.cerebras.maxTokens;
    
    if (!apiKey) {
      throw new Error("Cerebras API key is required");
    }
    
    // Initialize Cerebras client
    const cerebras = new Cerebras({ apiKey });
    
    // Create messages array with the question
    const messages = [
      { role: "system", content: "" }, // Empty system prompt
      { role: "user", content: question }
    ];

    console.log(`Asking Cerebras (${model}): "${question.substring(0, 50)}${question.length > 50 ? '...' : ''}"`);
    
    // Make the API call
    const response = await cerebras.chat.completions.create({
      messages: messages,
      model: model,
      stream: false, // Set to false to get the complete response at once
      max_completion_tokens: maxTokens,
      temperature: temperature,
      top_p: 1
    });
    
    // Extract and return the response text
    const responseText = response.choices[0]?.message?.content || '';
    return responseText;
  } catch (error) {
    console.error(`Error in ask_cerebras: ${error.message}`);
    throw error;
  }
}

module.exports = { ask_cerebras };
