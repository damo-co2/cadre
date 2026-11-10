import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context, MiddlewareHandler } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { Hono } from "hono";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { hostname, networkInterfaces } from "node:os";
import { extname, join, resolve, sep } from "node:path";
import QRCode from "qrcode";
import { ACCESS_COOKIE, type AccessInfo } from "@grokbot/shared";
import type { AppEnv } from "./context.js";

/**
 * Phone access. The server listens on every interface so a phone on the same Wi-Fi can reach it,
 * but only loopback callers (the desktop app) get in without a token. The QR code carries the
 * token once; the server swaps it for an HttpOnly cookie and redirects to a clean URL.
 */
export class AccessManager {
  private token: string;
  private rotatedAt: string;
  private file: string;

  constructor(dataDir: string, private port: number) {
    this.file = join(dataDir, "access.json");
    try {
      const saved = JSON.parse(readFileSync(this.file, "utf8")) as { token: string; rotatedAt: string };
      this.token = saved.token;
      this.rotatedAt = saved.rotatedAt;
    } catch {
      this.token = "";
      this.rotatedAt = "";
      this.rotate();
    }
  }

  rotate(): void {
    this.token = randomBytes(24).toString("base64url");
    this.rotatedAt = new Date().toISOString();
    writeFileSync(this.file, JSON.stringify({ token: this.token, rotatedAt: this.rotatedAt }), { mode: 0o600 });
  }

  check(given: string | undefined | null): boolean {
    if (!given) return false;
    const a = Buffer.from(given);
    const b = Buffer.from(this.token);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** Non-internal IPv4 addresses, Wi-Fi/Ethernet first, plus the Bonjour name. */
  hosts(): string[] {
    const ifs = networkInterfaces();
    const ranked = Object.entries(ifs)
      .flatMap(([name, addrs]) => (addrs ?? []).filter((a) => a.family === "IPv4" && !a.internal && !a.address.startsWith("169.254.")).map((a) => ({ name, address: a.address })))
      .sort((x, y) => rank(x.name) - rank(y.name));
    const host = hostname();
    const local = host.endsWith(".local") ? host : `${host}.local`;
    return [...new Set([...ranked.map((r) => r.address), local])];
  }

  async info(): Promise<AccessInfo> {
    const urls = this.hosts().map((h) => `http://${h}:${this.port}/?token=${this.token}`);
    const url = urls[0] ?? `http://localhost:${this.port}/?token=${this.token}`;
    const qrSvg = await QRCode.toString(url, { type: "svg", margin: 1, errorCorrectionLevel: "M", color: { dark: "#000000", light: "#ffffff" } });
    return { url, urls, qrSvg, port: this.port, rotatedAt: this.rotatedAt };
  }
}

function rank(ifName: string): number {
  if (ifName === "en0") return 0;
  if (/^en\d/.test(ifName)) return 1;
  if (/^(eth|wlan|wl)/.test(ifName)) return 2;
  if (/^(utun|bridge|vmnet|docker|veth|llw|awdl)/.test(ifName)) return 9;
  return 5;
}

export function isLoopback(address: string | undefined): boolean {
  if (!address) return false;
  return address === "::1" || address.startsWith("127.") || address.startsWith("::ffff:127.");
}

function remoteAddress(c: Context): string | undefined {
  try {
    return getConnInfo(c).remote.address;
  } catch {
    return undefined;
  }
}

export function callerIsLocal(c: Context): boolean {
  return isLoopback(remoteAddress(c));
}

/** Hosts a loopback request may name (stops DNS-rebinding pages from driving the local server). */
function hostAllowed(hostHeader: string | undefined, access: AccessManager): boolean {
  if (!hostHeader) return true;
  const h = hostHeader.replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h === "127.0.0.1" || h === "::1") return true;
  return access.hosts().some((x) => x.toLowerCase() === h);
}

const SIGN_IN_PAGE = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cadre</title>
<body style="font:16px -apple-system,system-ui,sans-serif;background:#0e0e11;color:#eee;display:grid;place-items:center;min-height:100vh;margin:0;padding:24px;text-align:center">
<div><div style="font-size:22px;font-weight:600;margin-bottom:8px">Scan to sign in</div>
<div style="color:#999;max-width:320px">Open Cadre on your Mac, go to Settings → Phone, and scan the QR code with this phone's camera.</div></div></body>`;

export function accessMiddleware(access: AccessManager): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const path = c.req.path;
    if (callerIsLocal(c)) {
      if (!hostAllowed(c.req.header("host"), access)) return c.text("Forbidden host", 403);
      return next();
    }
    // Webhooks carry their own per-routine bearer key; the MCP endpoint is for local model CLIs only.
    if (path.startsWith("/api/hooks/")) return next();
    if (path.startsWith("/mcp")) return c.json({ error: "Not available remotely" }, 403);
    if (path === "/api/health") return c.json({ ok: true });

    const query = c.req.query("token");
    if (query && access.check(query)) {
      setCookie(c, ACCESS_COOKIE, query, { httpOnly: true, sameSite: "Lax", path: "/", maxAge: 60 * 60 * 24 * 365 });
      if (c.req.method === "GET" && !path.startsWith("/api/") && path !== "/ws") {
        const url = new URL(c.req.url);
        url.searchParams.delete("token");
        return c.redirect(url.pathname + (url.search || ""), 302);
      }
      return next();
    }
    const bearer = c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
    if (access.check(getCookie(c, ACCESS_COOKIE)) || access.check(bearer)) return next();
    if (path.startsWith("/api/") || path === "/ws") return c.json({ error: "Sign in by scanning the QR code in Cadre → Settings → Phone" }, 401);
    return c.html(SIGN_IN_PAGE, 401);
  };
}

/** GET /api/access (QR + URLs) and POST /api/access/rotate: desktop only. */
export function accessRoutes(access: AccessManager) {
  const r = new Hono<AppEnv>();
  r.use("*", async (c, next) => (callerIsLocal(c) ? next() : c.json({ error: "Only available on the Mac running Cadre" }, 403)));
  r.get("/", async (c) => c.json(await access.info()));
  r.post("/rotate", async (c) => {
    access.rotate();
    return c.json(await access.info());
  });
  return r;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".map": "application/json",
};

/** Serves the built desktop renderer to phone browsers (SPA fallback to index.html). */
export function rendererHandler(dir: string | null): MiddlewareHandler<AppEnv> {
  const root = dir ? resolve(dir) : null;
  return async (c, next) => {
    if (c.req.method !== "GET" || c.req.path.startsWith("/api/") || c.req.path.startsWith("/mcp") || c.req.path === "/ws") return next();
    if (!root || !existsSync(join(root, "index.html"))) {
      return c.html(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font:16px system-ui;padding:24px">Cadre's web app is not built. On the Mac run <code>npm run build</code>.</body>`, 503);
    }
    let rel = decodeURIComponent(c.req.path);
    if (rel === "/" || rel === "") rel = "/index.html";
    let file = resolve(root, `.${rel}`);
    if (!file.startsWith(root + sep) || !existsSync(file) || statSync(file).isDirectory()) file = join(root, "index.html");
    const body = readFileSync(file);
    const immutable = file.includes(`${sep}assets${sep}`);
    return new Response(body, {
      headers: {
        "content-type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream",
        "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
      },
    });
  };
}
