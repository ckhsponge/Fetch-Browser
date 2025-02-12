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
import { Window } from "happy-dom";
import { JSDOM } from "jsdom";
import { writeFileSync } from "fs";

// Constants
const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY = 1000; // 1 second
const MAX_RESPONSE_SIZE = 10 * 1024 * 1024; // 10MB
const DEFAULT_TIMEOUT = 30000; // 30 seconds
const GOOGLE_SEARCH_URL = 'https://www.google.com/search';
const MAX_SEARCH_RESULTS = 5;

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache',
  'Sec-Ch-Ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"macOS"',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1'
};

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

interface FetchUrlParams {
  url: URL;
  responseType?: 'json' | 'markdown';
  timeout?: number;
}

/**
 * Helper function for exponential backoff
 */
function getRetryDelay(attempt: number): number {
  return INITIAL_RETRY_DELAY * Math.pow(2, attempt);
}

/**
 * Extract Google search results from HTML.
 *
 * Depending on the content, it looks for a news structure (using the
 * [data-news-cluster-id] attribute) or falls back to general result elements (using the
 * ".g" selector). This mimics the extraction logic seen in the local-web-search repo.
 *
 * @param html - The HTML string to parse.
 * @param responseType - The desired output format.
 * @returns The results in the chosen format.
 */
function extractGoogleResults(html: string, responseType: 'text' | 'json' | 'html' | 'markdown'): string | object[] {
  const dom = new Window({
    settings: {
      disableJavaScriptFileLoading: true,
      disableJavaScriptEvaluation: true,
      disableCSSFileLoading: true,
      timer: {
        maxTimeout: 3000,
        maxIntervalTime: 3000,
      },
    },
  });

  const document = dom.document;
  document.write(html);

  console.log(`Document body length: ${document.body.innerHTML.length}`);

  const results: { title: string; url: string; description?: string }[] = [];

  // Try news results first
  const newsElements = document.querySelectorAll('[data-news-cluster-id]');
  console.log(`Found ${newsElements.length} news elements`);

  newsElements.forEach((element, index) => {
    console.log(`Processing news element ${index + 1}`);
    const titleEl = element.querySelector('[role="heading"]');
    const linkEl = element.querySelector('a');
    const snippetEl = titleEl?.nextElementSibling;

    if (titleEl && linkEl) {
      const title = titleEl.textContent?.trim();
      const url = linkEl.getAttribute('href');
      const description = snippetEl?.textContent?.trim();

      if (title && url) {
        results.push({ title, url, description });
      } else {
        console.log(`Missing title or URL for news element ${index + 1}`);
      }
    }
  });

  // If no news results, try general search results
  if (results.length === 0) {
    const generalElements = document.querySelectorAll('.g');
    console.log(`Found ${generalElements.length} general result elements`);

    generalElements.forEach((element, index) => {
      console.log(`Processing general element ${index + 1}`);
      const titleEl = element.querySelector('h3');
      const linkEl = element.querySelector('a');
      const snippetEl = element.querySelector('.VwiC3b');

      if (titleEl && linkEl) {
        const title = titleEl.textContent?.trim();
        const url = linkEl.getAttribute('href');
        const description = snippetEl?.textContent?.trim();

        if (title && url) {
          results.push({ title, url, description });
        } else {
          console.log(`Missing title or URL for general element ${index + 1}`);
        }
      }
    });
  }

  // If still no results, try alternative selectors
  if (results.length === 0) {
    console.log('No results found with primary selectors, trying alternatives...');
    const alternativeElements = document.querySelectorAll('div.tF2Cxc');
    alternativeElements.forEach((element, index) => {
      console.log(`Processing alternative element ${index + 1}`);
      const titleEl = element.querySelector('h3');
      const linkEl = element.querySelector('a');
      const snippetEl = element.querySelector('.VwiC3b');

      if (titleEl && linkEl) {
        const title = titleEl.textContent?.trim();
        const url = linkEl.getAttribute('href');
        const description = snippetEl?.textContent?.trim();

        if (title && url) {
          results.push({ title, url, description });
        } else {
          console.log(`Missing title or URL for alternative element ${index + 1}`);
        }
      }
    });
  }

  console.log(`Total results found: ${results.length}`);
  dom.happyDOM?.close();

  switch (responseType) {
    case 'markdown':
      return results.map(r => `- [${r.title}](${r.url})${r.description ? `\n  ${r.description}` : ''}`).join('\n');
    case 'html':
      return results.map(r => `<div class="result"><h3><a href="${r.url}">${r.title}</a></h3>${r.description ? `<p>${r.description}</p>` : ''}</div>`).join('\n');
    case 'text':
      return results.map(r => `${r.title}\n${r.url}${r.description ? `\n${r.description}` : ''}`).join('\n\n');
    case 'json':
    default:
      return results;
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
    const mappedType = responseType === 'json' || responseType === 'markdown' ? responseType : 'json';
    const results = await extractGoogleResults(text, mappedType);
    return typeof results === 'string' ? results : JSON.stringify(results, null, 2);
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

          const response = await fetch(params.url.toString(), {
            signal: controller.signal,
            headers: BROWSER_HEADERS,
            redirect: 'follow'
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

export async function fetchUrl(url: string, responseType: 'text' | 'json' | 'html' | 'markdown' = 'json'): Promise<string | object[]> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: BROWSER_HEADERS,
      redirect: 'follow'
    });

    clearTimeout(timeout);

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const html = await response.text();
    writeFileSync('fetchedPage.html', html);
    console.log(`Saved fetched HTML (${html.length} bytes) to fetchedPage.html`);

    if (url.startsWith(GOOGLE_SEARCH_URL)) {
      return extractGoogleResults(html, responseType);
    }

    switch (responseType) {
      case 'markdown':
        return htmlToMarkdown(html);
      case 'html':
        return html;
      case 'text':
        return html;
      case 'json':
      default:
        return [{ content: html }];
    }
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Failed to fetch URL: ${error.message}`);
    }
    throw error;
  }
}

export async function fetchUrlWithParams(params: FetchUrlParams): Promise<string | object[]> {
  return await z.object({
    url: z.instanceof(URL),
    responseType: z.enum(['json', 'markdown']).default('json'),
    timeout: z.number().min(1000).max(30000).default(5000)
  }).parseAsync(params).then(
    async (params) => {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), params.timeout);

        const response = await fetch(params.url.toString(), {
          signal: controller.signal,
          headers: BROWSER_HEADERS,
          redirect: 'follow'
        });

        clearTimeout(timeout);

        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }

        const html = await response.text();

        if (params.url.origin + params.url.pathname === GOOGLE_SEARCH_URL) {
          return extractGoogleResults(html, params.responseType);
        }

        return params.responseType === 'markdown' ? html : [{ content: html }];
      } catch (error) {
        if (error instanceof Error) {
          throw new Error(`Failed to fetch URL: ${error.message}`);
        }
        throw error;
      }
    }
  );
}
