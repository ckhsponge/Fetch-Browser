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
 * Register the Google search tool with the MCP server
 */
export function registerGoogleSearchTool(server: McpServer) {
  server.tool(
    "google_search",
    "Execute a Google search and return results in various formats",
    GoogleSearchSchema.shape,
    async (params) => {
      try {
        const url = buildGoogleSearchUrl({
          query: params.query,
          maxResults: params.maxResults,
          topic: params.topic
        });

        const results = await fetchUrl(url, params.responseType);

        return {
          content: [{
            type: "text",
            text: typeof results === 'string' ? results : JSON.stringify(results, null, 2),
            mimeType: params.responseType === 'json' ? 'application/json' :
              params.responseType === 'markdown' ? 'text/markdown' :
                params.responseType === 'html' ? 'text/html' : 'text/plain'
          }],
          metadata: {
            query: params.query,
            topic: params.topic,
            maxResults: params.maxResults,
            responseType: params.responseType
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
