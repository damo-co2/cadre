/**
 * A fake "app" for the end-to-end test: a remote MCP server behind OAuth 2.1 with dynamic client
 * registration (like Jira, Linear, Notion). Tools: search_items (read-only, needs `query`) and
 * create_item (changes data, needs `title`). Every call's arguments are appended to CALL_LOG.
 */
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const P = Number(process.env.MOCK_PORT ?? 4560);
const O = `http://localhost:${P}`;
const LOG = process.env.CALL_LOG ?? "/tmp/mock-app-calls.jsonl";
const json = (res: any, code: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(code, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};
const readBody = (req: any) => new Promise<string>((r) => { let b = ""; req.on("data", (c: any) => (b += c)); req.on("end", () => r(b)); });
const log = (tool: string, args: unknown) => appendFileSync(LOG, JSON.stringify({ tool, args, at: new Date().toISOString() }) + "\n");

createServer(async (req, res) => {
  const url = new URL(req.url!, O);
  if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) return json(res, 200, { resource: `${O}/mcp`, authorization_servers: [O] });
  if (url.pathname.startsWith("/.well-known/oauth-authorization-server"))
    return json(res, 200, { issuer: O, authorization_endpoint: `${O}/authorize`, token_endpoint: `${O}/token`, registration_endpoint: `${O}/register`, response_types_supported: ["code"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"], grant_types_supported: ["authorization_code", "refresh_token"] });
  if (url.pathname === "/register") return json(res, 201, { ...JSON.parse(await readBody(req)), client_id: "mock-client" });
  if (url.pathname === "/authorize") {
    const to = new URL(url.searchParams.get("redirect_uri")!);
    to.searchParams.set("code", "the-code");
    to.searchParams.set("state", url.searchParams.get("state")!);
    res.writeHead(302, { location: to.toString() });
    return res.end();
  }
  if (url.pathname === "/token") return json(res, 200, { access_token: "tok-1", token_type: "Bearer", refresh_token: "ref-1", expires_in: 3600 });
  if (url.pathname === "/mcp") {
    if (req.headers.authorization !== "Bearer tok-1") return json(res, 401, { error: "unauthorized" }, { "www-authenticate": `Bearer resource_metadata="${O}/.well-known/oauth-protected-resource/mcp"` });
    const server = new McpServer({ name: "mockapp", version: "1" });
    server.registerTool("search_items", { description: "Search items by text. Returns matching item names.", inputSchema: { query: z.string().describe("What to search for") }, annotations: { readOnlyHint: true } }, async ({ query }) => {
      log("search_items", { query });
      return { content: [{ type: "text", text: `Found 2 items for "${query}": ITEM-7 ${query} (blue), ITEM-9 ${query} (large)` }] };
    });
    server.registerTool("create_item", { description: "Create a new item.", inputSchema: { title: z.string() } }, async ({ title }) => {
      log("create_item", { title });
      return { content: [{ type: "text", text: `Created ITEM-42 "${title}"` }] };
    });
    const t = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(t);
    return t.handleRequest(req, res, req.method === "POST" ? JSON.parse(await readBody(req)) : undefined);
  }
  res.writeHead(404);
  res.end();
}).listen(P, () => console.log(`mock app on ${O}`));
