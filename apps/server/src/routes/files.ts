import { Hono } from "hono";
import { createReadStream, existsSync, mkdirSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { basename, extname, join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { MAX_ATTACHMENTS_PER_MESSAGE, MAX_DOCUMENT_BYTES, MAX_IMAGE_BYTES } from "@grokbot/shared";
import type { AppEnv } from "../context.js";

export function filesRoutes(filesDir: string, workspaceDir: string) {
  mkdirSync(filesDir, { recursive: true });

  const uploads = new Hono<AppEnv>();

  /** multipart/form-data with one or more "files" fields → Attachment[] */
  uploads.post("/", async (c) => {
    const body = await c.req.parseBody({ all: true });
    const raw = body.files ?? body.file;
    const list = (Array.isArray(raw) ? raw : raw ? [raw] : []).filter((f): f is File => f instanceof File);
    if (!list.length) return c.json({ error: 'Send files in a "files" form field' }, 400);
    if (list.length > MAX_ATTACHMENTS_PER_MESSAGE) return c.json({ error: `Up to ${MAX_ATTACHMENTS_PER_MESSAGE} files per message` }, 400);
    const store = c.get("store");
    const out = [];
    for (const f of list) {
      const mimeType = f.type || guessMime(f.name);
      const limit = mimeType.startsWith("image/") ? MAX_IMAGE_BYTES : MAX_DOCUMENT_BYTES;
      if (f.size > limit) return c.json({ error: `${f.name} is too large (${Math.round(f.size / 1e6)} MB)` }, 400);
      const att = store.uploads.create({ name: basename(f.name) || "file", mimeType, size: f.size });
      await writeFile(join(filesDir, att.id), Buffer.from(await f.arrayBuffer()));
      out.push(att);
    }
    return c.json(out, 201);
  });

  const files = new Hono<AppEnv>();

  files.get("/:id", (c) => {
    const att = c.get("store").uploads.get(c.req.param("id"));
    const path = join(filesDir, c.req.param("id"));
    if (!att || !existsSync(path)) return c.json({ error: "Not found" }, 404);
    return serve(c, path, att.name, att.mimeType, c.req.query("download") === "1");
  });

  const workspace = new Hono<AppEnv>();

  /** GET /api/workspace?path=relative/file → bytes, confined to the workspace. */
  workspace.get("/", (c) => {
    const rel = c.req.query("path") ?? "";
    const abs = resolve(workspaceDir, rel);
    if (!abs.startsWith(resolve(workspaceDir) + sep) || !existsSync(abs) || !statSync(abs).isFile()) return c.json({ error: "Not found" }, 404);
    return serve(c, abs, basename(abs), guessMime(abs), c.req.query("download") === "1");
  });

  return { uploads, files, workspace };
}

function serve(_c: unknown, path: string, name: string, mime: string, download: boolean): Response {
  const size = statSync(path).size;
  const stream = Readable.toWeb(createReadStream(path)) as ReadableStream;
  const disposition = `${download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(name)}`;
  return new Response(stream, {
    status: 200,
    headers: { "content-type": mime, "content-length": String(size), "content-disposition": disposition, "cache-control": "private, max-age=3600" },
  });
}

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".json": "application/json",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".ts": "text/plain; charset=utf-8",
  ".py": "text/plain; charset=utf-8",
  ".mp4": "video/mp4",
  ".mp3": "audio/mpeg",
  ".zip": "application/zip",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

export function guessMime(name: string): string {
  return MIME[extname(name).toLowerCase()] ?? "application/octet-stream";
}
