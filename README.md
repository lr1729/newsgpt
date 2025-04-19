# News Scraper with AI Analysis

This application scrapes news articles from websites (including those with paywalls) and uses multiple AI models to analyze and summarize the content.

## Features

- Bypasses paywalls using a Chrome extension
- Extracts the main content from news articles
- Analyzes content using both Cerebras and Google Gemini AI models
- Configurable through environment variables
- Saves all outputs (HTML, extracted text, and AI analysis)

## Installation

1. Clone this repository:
```bash
git clone <repository-url>
cd news-scraper-ai-analyzer
```

2. Install dependencies:
```bash
npm install
```

3. Set up your environment variables by copying the example file:
```bash
cp .env.example .env
```

4. Edit the `.env` file with your API keys and configuration.

## Usage

### Basic Usage

```bash
npm start https://www.example.com/article-url
```

Or run directly:

```bash
node integrated-scraper.js https://www.example.com/article-url
```

If no URL is provided, it will use the default URL from the code.

### Configuration

Configure the application by editing the `.env` file:

- `CEREBRAS_API_KEY`: Your Cerebras API key
- `GEMINI_API_KEY`: Your Google Gemini API key
- `CEREBRAS_MODEL`: The Cerebras model to use (default: llama-4-scout-17b-16e-instruct)
- `GEMINI_MODEL`: The Gemini model to use (default: gemini-2.5-pro-preview-03-25)
- `EXTENSION_PATH`: Path to the bypass paywall extension
- `OUTPUT_DIR`: Directory to save output files

## Output

For each article, the application creates:
- `.html` file: The raw HTML from the website
- `.txt` file: The extracted article text
- `_analysis.json`: The analysis results from both AI models

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

This project is licensed under the MIT License - see the LICENSE file for details.
