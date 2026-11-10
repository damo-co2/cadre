import { StreamableHTTPTransport } from "@hono/mcp";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context.js";

/**
 * The Bot's computer as an MCP server, one endpoint per Bot: /mcp/:botId.
 * CLI drivers (Claude Code, Codex) connect here, so their tool calls take the same
 * Auto Review path as API drivers (runtime.callComputerTool). Stateless: a fresh
 * McpServer per request, which is what the Streamable HTTP transport expects here.
 */
export const mcpRoute = new Hono<AppEnv>();

mcpRoute.all("/:botId", async (c) => {
  const botId = c.req.param("botId");
  const store = c.get("store");
  const bot = store.bots.get(botId);
  if (!bot) return c.json({ error: "Unknown bot" }, 404);
  const runtime = c.get("runtime");

  // Low-level server so every tool is published with its real JSON schema. Connector (app) tools
  // keep the app's own schema and get their arguments untouched; the app validates them. (The
  // high-level McpServer needs a zod shape and silently stripped app tool arguments.)
  const specs = runtime.toolSpecs(bot);
  const byName = new Map(specs.map((t) => [t.name, t]));
  const server = new Server({ name: "cadre-computer", version: "0.1.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: specs.map((t) => ({ name: t.name, description: t.description, inputSchema: { type: "object", ...t.inputSchema } as { type: "object" } })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const t = byName.get(req.params.name);
    if (!t) return { isError: true, content: [{ type: "text" as const, text: `Unknown tool: ${req.params.name}` }] };
    let args: unknown = req.params.arguments ?? {};
    if (Object.keys(t.zodShape).length) {
      const parsed = z.object(t.zodShape).safeParse(args);
      if (!parsed.success) return { isError: true, content: [{ type: "text" as const, text: `Invalid arguments for ${t.name}: ${parsed.error.message}` }] };
      args = parsed.data;
    }
    const result = await runtime.callTool(botId, t.name, args);
    return {
      isError: result.isError,
      content: result.content.map((p) =>
        p.type === "image" ? { type: "image" as const, data: p.data, mimeType: p.mimeType } : { type: "text" as const, text: p.text },
      ),
    };
  });
  const transport = new StreamableHTTPTransport();
  await server.connect(transport);
  return transport.handleRequest(c);
});
