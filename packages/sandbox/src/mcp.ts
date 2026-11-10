/**
 * Exposes one Bot's computer as an MCP server (for CLI drivers such as
 * claude-code / codex / gemini-cli that speak MCP instead of API tools).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ComputerService } from "./index.js";

export function createMcpServer(service: ComputerService, botId: string): McpServer {
  const server = new McpServer({ name: "cadre-computer", version: "0.1.0" });
  for (const tool of service.listTools()) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.zodShape },
      async (args: unknown) => {
        const result = await service.callTool(botId, tool.name, args ?? {});
        return {
          content: result.content.map((c) =>
            c.type === "image"
              ? { type: "image" as const, data: c.data, mimeType: c.mimeType }
              : { type: "text" as const, text: c.text },
          ),
          isError: result.isError ?? false,
        };
      },
    );
  }
  return server;
}
