/**
 * URL Fetcher Tool
 *
 * This module implements an MCP tool for fetching and processing URLs.
 * It includes features like:
 * - Proper URL validation and sanitization
 * - Response type handling (HTML, JSON, text, markdown)
 * - Special handling for Google search results
 * - Error handling and retries
 * - Rate limiting protection
 * - Security headers and user agent
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { JSDOM } from 'jsdom';

// Constants
const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY = 1000; // 1 second
const MAX_RESPONSE_SIZE = 10 * 1024 * 1024; // 10MB
const DEFAULT_TIMEOUT = 30000; // 30 seconds
const GOOGLE_SEARCH_URL = 'https://www.google.com/search';
const MAX_SEARCH_RESULTS = 5;

// Schema for URL fetcher parameters
const UrlFetcherSchema = z.object({
  url: z.string()
    .url()
    .transform(url => new URL(url))
    .describe("The URL to fetch"),
  responseType: z.enum(['text', 'json', 'html', 'markdown'])
    .default('text')
    .describe("Expected response type"),
  timeout: z.number()
    .min(1000)
    .max(60000)
    .default(DEFAULT_TIMEOUT)
    .describe("Request timeout in milliseconds")
});

/**
 * Helper function for exponential backoff
 */
function getRetryDelay(attempt: number): number {
  return INITIAL_RETRY_DELAY * Math.pow(2, attempt);
}

/**
 * Extract search results from Google HTML
 */
function extractGoogleResults(html: string, responseType: 'text' | 'json' | 'html' | 'markdown'): string {
  try {
    // Create a virtual DOM to parse the HTML
    const dom = new JSDOM(html);
    const doc = dom.window.document;
    const results: { title: string; url: string; description: string }[] = [];

    // Find all search result divs using modern Google selectors
    const resultDivs = doc.querySelectorAll('div.g');

    for (let i = 0; i < Math.min(MAX_SEARCH_RESULTS, resultDivs.length); i++) {
      const div = resultDivs[i];

      // Extract title using h3 selector
      const titleEl = div.querySelector('h3');
      const title = titleEl ? titleEl.textContent?.trim() : '';

      // Extract URL from the main link
      const linkEl = div.querySelector('a');
      const url = linkEl ? linkEl.getAttribute('href') : '';

      // Extract description from the snippet div
      const descEl = div.querySelector('.VwiC3b, .s');  // Google uses multiple classes
      const description = descEl ? descEl.textContent?.trim() : '';

      // Only add if we have at least a title and URL
      if (title && url) {
        results.push({
          title: title || 'No title',
          url: url || '',
          description: description || 'No description'
        });
      }
    }

    // If no results found, try alternative selectors
    if (results.length === 0) {
      const altResultDivs = doc.querySelectorAll('.tF2Cxc');
      for (let i = 0; i < Math.min(MAX_SEARCH_RESULTS, altResultDivs.length); i++) {
        const div = altResultDivs[i];
        const titleEl = div.querySelector('h3');
        const linkEl = div.querySelector('a');
        const descEl = div.querySelector('.VwiC3b, .s');

        const title = titleEl ? titleEl.textContent?.trim() : '';
        const url = linkEl ? linkEl.getAttribute('href') : '';
        const description = descEl ? descEl.textContent?.trim() : '';

        if (title && url) {
          results.push({
            title: title || 'No title',
            url: url || '',
            description: description || 'No description'
          });
        }
      }
    }

    // Format results based on response type
    switch (responseType) {
      case 'json':
        return JSON.stringify(results, null, 2);

      case 'html':
        return results.map(result => `
          <div class="search-result">
            <h3><a href="${result.url}">${result.title}</a></h3>
            <div class="url">${result.url}</div>
            <div class="description">${result.description}</div>
          </div>
        `).join('\n');

      case 'markdown':
        return results.map((result, index) => `
${index + 1}. **${result.title}**
   - URL: ${result.url}
   - Description: ${result.description}
`).join('\n');

      case 'text':
      default:
        return results.map((result, index) => `
${index + 1}. ${result.title}
   URL: ${result.url}
   Description: ${result.description}
`).join('\n');
    }
  } catch (error) {
    throw new Error(`Failed to parse Google search results: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Convert HTML to Markdown
 */
function htmlToMarkdown(html: string): string {
  // Basic HTML to Markdown conversion
  return html
    // Headers
    .replace(/<h[1-6][^>]*>(.*?)<\/h[1-6]>/gi, (_, content) => `\n# ${content.trim()}\n`)
    // Bold
    .replace(/<(strong|b)>(.*?)<\/\1>/gi, '**$2**')
    // Italic
    .replace(/<(em|i)>(.*?)<\/\1>/gi, '*$2*')
    // Links
    .replace(/<a[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi, '[$2]($1)')
    // Lists
    .replace(/<(ul|ol)[^>]*>(.*?)<\/\1>/gi, (_, type, content) => {
      return content.replace(/<li[^>]*>(.*?)<\/li>/gi,
        type === 'ul' ? '- $1\n' : '1. $1\n'
      );
    })
    // Paragraphs
    .replace(/<p[^>]*>(.*?)<\/p>/gi, '\n$1\n')
    // Remove remaining HTML tags
    .replace(/<[^>]*>/g, '')
    // Fix spacing
    .replace(/\n\s*\n/g, '\n\n')
    .trim();
}

/**
 * Process response based on type
 */
async function processResponse(response: Response, responseType: 'text' | 'json' | 'html' | 'markdown', url: URL): Promise<string> {
  const contentType = response.headers.get('content-type') || '';

  // Check response size
  const contentLength = parseInt(response.headers.get('content-length') || '0');
  if (contentLength > MAX_RESPONSE_SIZE) {
    throw new Error('Response too large');
  }

  let text = await response.text();

  // Special handling for Google search results
  if (url.origin + url.pathname === GOOGLE_SEARCH_URL) {
    return extractGoogleResults(text, responseType);
  }

  switch (responseType) {
    case 'json':
      if (!contentType.includes('application/json')) {
        throw new Error('Response is not JSON');
      }
      // Pretty print JSON
      return JSON.stringify(JSON.parse(text), null, 2);

    case 'html':
      if (!contentType.includes('text/html')) {
        throw new Error('Response is not HTML');
      }
      return text;

    case 'markdown':
      if (contentType.includes('text/html')) {
        return htmlToMarkdown(text);
      } else if (contentType.includes('text/markdown')) {
        return text;
      }
      // If not HTML or Markdown, convert plain text to markdown
      return `\`\`\`\n${text}\n\`\`\``;

    case 'text':
    default:
      return text;
  }
}

/**
 * Register the URL fetcher tool with the MCP server
 */
export function registerUrlFetcherTool(server: McpServer) {
  server.tool(
    "fetch_url",
    "Fetch content from a URL with proper error handling and response processing",
    UrlFetcherSchema.shape,
    async (params) => {
      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), params.timeout);

          // Add special headers for Google search to improve results
          const headers: Record<string, string> = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
            'Accept': params.responseType === 'json' ? 'application/json' :
              params.responseType === 'html' ? 'text/html' : 'text/plain',
            'Accept-Language': 'en-US,en;q=0.9'
          };

          // If it's a Google search, add specific headers
          if (params.url.origin + params.url.pathname === GOOGLE_SEARCH_URL) {
            headers['Accept'] = 'text/html';
            headers['Cache-Control'] = 'no-cache';
            headers['Pragma'] = 'no-cache';
          }

          const response = await fetch(params.url.toString(), {
            signal: controller.signal,
            headers
          });

          clearTimeout(timeout);

          // Handle different status codes
          if (!response.ok) {
            if (response.status === 429) {
              if (attempt === MAX_RETRIES - 1) {
                return {
                  content: [{
                    type: "text",
                    text: "Rate limit exceeded. Please try again later."
                  }],
                  isError: true
                };
              }
              await new Promise(resolve => setTimeout(resolve, getRetryDelay(attempt)));
              continue;
            }

            return {
              content: [{
                type: "text",
                text: `HTTP ${response.status}: ${response.statusText}`
              }],
              isError: true
            };
          }

          // Process the response
          const processedContent = await processResponse(response, params.responseType, params.url);

          // Always return as text type with appropriate metadata
          return {
            content: [{
              type: "text",
              text: processedContent,
              mimeType: params.responseType === 'json' ? 'application/json' :
                params.responseType === 'markdown' ? 'text/markdown' :
                  params.responseType === 'html' ? 'text/html' : 'text/plain'
            }],
            metadata: {
              url: params.url.toString(),
              contentType: response.headers.get('content-type'),
              contentLength: response.headers.get('content-length'),
              isGoogleSearch: params.url.origin + params.url.pathname === GOOGLE_SEARCH_URL,
              responseType: params.responseType
            }
          };

        } catch (error) {
          if (error instanceof Error && error.name === 'AbortError') {
            return {
              content: [{
                type: "text",
                text: `Request timed out after ${params.timeout}ms`
              }],
              isError: true
            };
          }

          if (attempt === MAX_RETRIES - 1) {
            return {
              content: [{
                type: "text",
                text: `Failed to fetch URL: ${error instanceof Error ? error.message : 'Unknown error'}`
              }],
              isError: true
            };
          }

          await new Promise(resolve => setTimeout(resolve, getRetryDelay(attempt)));
        }
      }

      return {
        content: [{
          type: "text",
          text: "Failed to fetch URL after all retry attempts"
        }],
        isError: true
      };
    }
  );
}
