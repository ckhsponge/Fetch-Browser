/**
 * Fetch Browser
 *
 * An MCP server that acts as a browser, providing:
 * - Web content fetching in multiple formats (HTML, JSON, Text, Markdown)
 * - Smart Google search results parsing
 * - Error handling and retries
 * - Rate limiting protection
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerUrlFetcherTool } from "./url-fetcher.js";
import { registerGoogleSearchTool } from "./google-search.js";

/**
 * Create a new MCP server instance with full capabilities
 */
const server = new McpServer({
  name: "fetch-browser",
  version: "0.1.0",
  capabilities: {
    tools: {
      fetch_url: {
        description: "Fetch content from a URL with proper error handling and response processing",
        parameters: {
          url: "The URL to fetch",
          responseType: "Expected response type (text, json, html, markdown)",
          timeout: "Request timeout in milliseconds (optional)"
        }
      },
      google_search: {
        description: "Execute a Google search and return results in various formats",
        parameters: {
          query: "The search query to execute",
          responseType: "Expected response type (text, json, html, markdown)",
          maxResults: "Maximum number of results to return (optional)",
          topic: "Type of search to perform (web or news)"
        }
      }
    },
    resources: {},
    prompts: {},
    streaming: true
  }
});

/**
 * Helper function to send log messages to the client
 */
function logMessage(level: 'info' | 'warn' | 'error', message: string) {
  console.error(`[${level.toUpperCase()}] ${message}`);
}

/**
 * Set up error handling for the server
 */
process.on('uncaughtException', (error: Error) => {
  logMessage('error', `Uncaught error: ${error.message}`);
  console.error('Server error:', error);
});

// Register tools
try {
  registerUrlFetcherTool(server);
  registerGoogleSearchTool(server);
  logMessage('info', 'Successfully registered tools');
} catch (error) {
  logMessage('error', `Failed to register tools: ${error instanceof Error ? error.message : 'Unknown error'}`);
  process.exit(1);
}

/**
 * Set up proper cleanup on process termination
 */
async function cleanup() {
  try {
    await server.close();
    logMessage('info', 'Server shutdown completed');
  } catch (error) {
    logMessage('error', `Error during shutdown: ${error instanceof Error ? error.message : 'Unknown error'}`);
  } finally {
    process.exit(0);
  }
}

// Handle termination signals
process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);

/**
 * Main server startup function
 */
async function main() {
  try {
    // Set up communication with the MCP host using stdio transport
    const transport = new StdioServerTransport();
    await server.connect(transport);

    logMessage('info', 'Fetch Browser started successfully');
    console.error('Fetch Browser running on stdio transport');
  } catch (error) {
    logMessage('error', `Failed to start server: ${error instanceof Error ? error.message : 'Unknown error'}`);
    process.exit(1);
  }
}

// Start the server
main().catch((error) => {
  console.error('Fatal error in main():', error);
  process.exit(1);
});
