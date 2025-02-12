import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { fetchUrl } from "./url-fetcher.js";

// Schema for Google search parameters
const GoogleSearchSchema = z.object({
  query: z.string()
    .min(1)
    .describe("The search query to execute"),
  responseType: z.enum(['text', 'json', 'html', 'markdown'])
    .default('json')
    .describe("Expected response type"),
  maxResults: z.number()
    .min(1)
    .max(100)
    .default(10)
    .describe("Maximum number of results to return"),
  topic: z.enum(['web', 'news'])
    .default('web')
    .describe("Type of search to perform")
});

/**
 * Build a Google search URL with proper parameters
 */
function buildGoogleSearchUrl(options: {
  query: string;
  maxResults?: number;
  topic?: 'web' | 'news';
}): string {
  const searchParams = new URLSearchParams({
    q: options.query,
    num: `${options.maxResults || 10}`
  });

  if (options.topic === 'news') {
    // News tab
    searchParams.set("tbm", "nws");
  } else {
    // Web tab
    searchParams.set("udm", "14");
  }

  return `https://www.google.com/search?${searchParams.toString()}`;
}

/**
 * Extract URLs from search results
 */
async function extractSearchUrls(searchResults: string | object[]): Promise<string[]> {
  if (typeof searchResults === 'string') {
    // Parse markdown links
    const urlMatches = searchResults.matchAll(/\[.*?\]\((.*?)\)/g);
    return Array.from(urlMatches).map(match => match[1]);
  } else {
    // Extract URLs from JSON results
    return (searchResults as any[]).map(result => result.url);
  }
}

/**
 * Register the Google search tool with the MCP server
 */
export function registerGoogleSearchTool(server: McpServer) {
  server.tool(
    "google_search",
    "Execute a Google search and return results in various formats",
    GoogleSearchSchema.shape,
    async (params) => {
      try {
        // First, get the search results
        const searchUrl = buildGoogleSearchUrl({
          query: params.query,
          maxResults: params.maxResults,
          topic: params.topic
        });

        // Get search results in JSON format to extract URLs
        const searchResults = await fetchUrl(searchUrl, 'json');
        const urls = await extractSearchUrls(searchResults);

        // Now fetch the full content of each URL
        const fullResults = await Promise.all(
          urls.map(async (url) => {
            try {
              const content = await fetchUrl(url, params.responseType);
              return {
                url,
                content,
                error: null
              };
            } catch (error) {
              return {
                url,
                content: null,
                error: error instanceof Error ? error.message : 'Unknown error'
              };
            }
          })
        );

        // Format the results based on response type
        let formattedResults;
        switch (params.responseType) {
          case 'markdown':
            formattedResults = fullResults
              .map(r => r.error
                ? `## [Failed to fetch: ${r.url}]\nError: ${r.error}`
                : `## [${r.url}]\n\n${r.content}`)
              .join('\n\n---\n\n');
            break;
          case 'html':
            formattedResults = fullResults
              .map(r => r.error
                ? `<div class="search-result error"><h2><a href="${r.url}">Failed to fetch</a></h2><p class="error">${r.error}</p></div>`
                : `<div class="search-result"><h2><a href="${r.url}">${r.url}</a></h2>${r.content}</div>`)
              .join('\n');
            break;
          case 'text':
            formattedResults = fullResults
              .map(r => r.error
                ? `### ${r.url}\nError: ${r.error}`
                : `### ${r.url}\n\n${r.content}`)
              .join('\n\n==========\n\n');
            break;
          case 'json':
          default:
            formattedResults = JSON.stringify(fullResults, null, 2);
            break;
        }

        return {
          content: [{
            type: "text",
            text: formattedResults,
            mimeType: params.responseType === 'json' ? 'application/json' :
              params.responseType === 'markdown' ? 'text/markdown' :
                params.responseType === 'html' ? 'text/html' : 'text/plain'
          }],
          metadata: {
            query: params.query,
            topic: params.topic,
            maxResults: params.maxResults,
            responseType: params.responseType,
            resultsCount: fullResults.length,
            successCount: fullResults.filter(r => !r.error).length
          }
        };
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: `Failed to execute Google search: ${error instanceof Error ? error.message : 'Unknown error'}`
          }],
          isError: true
        };
      }
    }
  );
}
