/**
 * Shell and file tools. Commands run in the Bot's workspace directory; file
 * paths are confined to it.
 */
import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import os from "node:os";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { defineTool, fail, ok, ToolError, type ToolDef } from "./tools.js";

const HEAD_BYTES = 20 * 1024;
const TAIL_BYTES = 30 * 1024;

/** Keeps the first 20 KB and last 30 KB of a stream; reports total bytes seen. */
class CappedOutput {
  private head: Buffer[] = [];
  private headLen = 0;
  private tail: Buffer[] = [];
  private tailLen = 0;
  total = 0;

  push(chunk: Buffer): void {
    this.total += chunk.length;
    if (this.headLen < HEAD_BYTES) {
      const take = chunk.subarray(0, HEAD_BYTES - this.headLen);
      this.head.push(take);
      this.headLen += take.length;
      chunk = chunk.subarray(take.length);
      if (chunk.length === 0) return;
    }
    this.tail.push(chunk);
    this.tailLen += chunk.length;
    while (this.tailLen > TAIL_BYTES && this.tail.length) {
      const first = this.tail[0]!;
      const excess = this.tailLen - TAIL_BYTES;
      if (first.length <= excess) {
        this.tail.shift();
        this.tailLen -= first.length;
      } else {
        this.tail[0] = first.subarray(excess);
        this.tailLen -= excess;
      }
    }
  }

  toString(): string {
    const head = Buffer.concat(this.head).toString("utf8");
    if (this.total <= HEAD_BYTES) return head;
    const tail = Buffer.concat(this.tail).toString("utf8");
    const dropped = this.total - this.headLen - this.tailLen;
    if (dropped <= 0) return head + tail;
    return `${head}\n… [output truncated: ${dropped} bytes omitted of ${this.total} total] …\n${tail}`;
  }
}

export interface ShellResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  output: string;
  timedOut: boolean;
  aborted: boolean;
}

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/** True when commands can be confined with the macOS sandbox (Seatbelt). */
export function canConfine(): boolean {
  return process.platform === "darwin" && existsSync(SANDBOX_EXEC);
}

/** Folders a confined command may write to: the sandbox, temp folders and package-manager caches. */
export function confinedWriteRoots(sandboxDir: string): string[] {
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  const home = os.homedir();
  const caches = [".npm", ".cache", "Library/Caches", ".pnpm-store", "Library/pnpm", ".yarn", ".bun", ".composer", ".config/composer", ".cargo/registry", ".cargo/git", ".gradle", ".m2", ".node-gyp", ".local/share/pnpm"];
  return [...new Set([real(sandboxDir), "/private/tmp", "/private/var/folders", real(os.tmpdir()), ...caches.map((c) => path.join(home, c))])];
}

/** Seatbelt profile: everything allowed (reading, network, running programs) except writing outside `roots`. */
export function confinedProfile(roots: string[]): string {
  const q = (p: string) => `"${p.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  return [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    `(allow file-write* ${roots.map((r) => `(subpath ${q(r)})`).join(" ")} (literal "/dev/null") (regex #"^/dev/(tty|fd/|std|null|zero|dtracehelper|ptmx|ttys)"))`,
  ].join("\n");
}

export function runShell(
  command: string,
  opts: { cwd: string; timeoutMs: number; signal?: AbortSignal; env?: Record<string, string>; confineTo?: string },
): Promise<ShellResult> {
  const shell: [string, string[]] = existsSync("/bin/zsh") ? ["/bin/zsh", ["-lc", command]] : ["/bin/sh", ["-c", command]];
  const [bin, args]: [string, string[]] =
    opts.confineTo && canConfine() ? [SANDBOX_EXEC, ["-p", confinedProfile(confinedWriteRoots(opts.confineTo)), shell[0], ...shell[1]]] : shell;
  return new Promise((resolve, reject) => {
    const out = new CappedOutput();
    let timedOut = false;
    let aborted = false;
    const child = spawn(bin, args, {
      cwd: opts.cwd,
      env: { ...process.env, PWD: opts.cwd, ...(opts.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    const kill = () => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, opts.timeoutMs);
    const onAbort = () => {
      aborted = true;
      kill();
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => out.push(c));
    child.on("error", (e) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      reject(e);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({ code, signal, output: out.toString(), timedOut, aborted });
    });
  });
}

/** Resolve a user-supplied path inside the workspace; rejects anything that escapes it. */
export function resolveInWorkspace(workspaceDir: string, p: string): { abs: string; rel: string } {
  const abs = path.resolve(workspaceDir, p || ".");
  if (abs !== workspaceDir && !abs.startsWith(workspaceDir + path.sep)) {
    throw new ToolError(`Path ${JSON.stringify(p)} is outside the workspace (${workspaceDir}). Use a path relative to the workspace root.`);
  }
  const rel = path.relative(workspaceDir, abs) || ".";
  return { abs, rel };
}

const SKIP_DIRS = new Set(["node_modules", ".git", ".DS_Store"]);

async function listTree(abs: string, rel: string, depth: number, maxDepth: number, lines: string[], budget: { left: number }): Promise<void> {
  const entries = await fs.readdir(abs, { withFileTypes: true });
  entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
  const indent = "  ".repeat(depth);
  for (const e of entries) {
    if (budget.left-- <= 0) {
      lines.push(`${indent}… (listing capped)`);
      return;
    }
    const childAbs = path.join(abs, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) {
        lines.push(`${indent}${e.name}/ (skipped)`);
        continue;
      }
      lines.push(`${indent}${e.name}/`);
      if (depth + 1 < maxDepth) await listTree(childAbs, path.join(rel, e.name), depth + 1, maxDepth, lines, budget);
    } else if (e.isSymbolicLink()) {
      lines.push(`${indent}${e.name} -> (symlink)`);
    } else {
      const st = await fs.stat(childAbs).catch(() => null);
      lines.push(`${indent}${e.name}  ${st ? formatSize(st.size) : ""}`);
    }
  }
}

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export const shellAndFsTools: ToolDef[] = [
  defineTool(
    "shell_run",
    "Run a shell command in the Bot's workspace directory (zsh login shell; the environment is inherited, so installed tools like git, node, python and curl work; secrets granted from the Vault arrive as environment variables). Returns `exit=<code>` followed by combined stdout+stderr (capped at 50 KB). Long-running commands are killed at the timeout. Use for builds, scripts, git, package managers, file searches and anything the browser cannot do.",
    {
      command: z.string().min(1).describe("The command line to run, e.g. \"ls -la\" or \"npm test\"."),
      outsideSandbox: z
        .boolean()
        .optional()
        .describe("Set true only when the command must change something outside the sandbox folder; the user is asked to approve it first. Leave unset for everything else: it runs right away."),
      timeoutSec: z.number().int().min(1).max(600).optional().describe("Kill the command after this many seconds (default 60, max 600)."),
    },
    async (ctx, { command, timeoutSec }) => {
      const res = await runShell(command, { cwd: ctx.workspaceDir, timeoutMs: (timeoutSec ?? 60) * 1000, signal: ctx.signal, env: ctx.env, confineTo: ctx.confineTo });
      const blocked =
        ctx.confineTo && /operation not permitted/i.test(res.output)
          ? `\n[sandbox: this command ran without approval, so writing outside ${ctx.confineTo} was blocked. If it really must change something outside, run it again with outsideSandbox: true and the user will be asked.]`
          : "";
      const note = res.timedOut
        ? `\n[killed: exceeded ${timeoutSec ?? 60}s timeout; raise timeoutSec or run it in the background with nohup/&]`
        : res.aborted
          ? "\n[killed: the call was cancelled]"
          : res.signal
            ? `\n[terminated by signal ${res.signal}]`
            : "";
      const text = `exit=${res.code ?? (res.timedOut || res.aborted ? 137 : -1)}\n${res.output}${note}${blocked}`;
      return res.timedOut || res.aborted ? fail(text) : ok(text);
    },
  ),

  defineTool(
    "fs_read",
    "Read a UTF-8 text file from the workspace. Paths are relative to the workspace root (absolute paths must be inside it). Large files are truncated; pass maxChars to read more.",
    {
      path: z.string().min(1).describe("File path relative to the workspace, e.g. \"notes/todo.md\"."),
      maxChars: z.number().int().min(100).max(2_000_000).optional().describe("Maximum characters to return (default 50000)."),
    },
    async (ctx, { path: p, maxChars }) => {
      const { abs, rel } = resolveInWorkspace(ctx.workspaceDir, p);
      const st = await fs.stat(abs).catch(() => null);
      if (!st) return fail(`${rel} does not exist. Call fs_list to see what is in the workspace.`);
      if (st.isDirectory()) return fail(`${rel} is a directory. Use fs_list to see its contents.`);
      const limit = maxChars ?? 50_000;
      const buf = await fs.readFile(abs);
      if (buf.subarray(0, 8192).includes(0)) return fail(`${rel} looks like a binary file (${formatSize(st.size)}); fs_read only returns text. Use shell_run with a suitable tool instead.`);
      const text = buf.toString("utf8");
      const body = text.length > limit ? `${text.slice(0, limit)}\n… truncated (${text.length} chars total; raise maxChars or read in pieces with shell_run sed/head/tail)` : text;
      return ok(body);
    },
  ),

  defineTool(
    "fs_write",
    "Write a text file in the workspace, creating parent directories as needed. Overwrites by default; set append=true to add to the end. Returns the number of bytes written. Read the file first if you intend to edit it rather than replace it.",
    {
      path: z.string().min(1).describe("File path relative to the workspace."),
      content: z.string().describe("Full text content to write (or to append)."),
      append: z.boolean().optional().describe("Append instead of overwrite (default false)."),
    },
    async (ctx, { path: p, content, append }) => {
      const { abs, rel } = resolveInWorkspace(ctx.workspaceDir, p);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      const bytes = Buffer.byteLength(content, "utf8");
      if (append) await fs.appendFile(abs, content, "utf8");
      else await fs.writeFile(abs, content, "utf8");
      return ok(`${append ? "Appended" : "Wrote"} ${bytes} bytes to ${rel}`);
    },
  ),

  defineTool(
    "fs_list",
    "List files and folders in the workspace as an indented tree with sizes (node_modules and .git are skipped). Use depth to look deeper into subfolders.",
    {
      path: z.string().optional().describe("Directory relative to the workspace (default \".\", the workspace root)."),
      depth: z.number().int().min(1).max(4).optional().describe("How many levels deep to list (default 1, max 4)."),
    },
    async (ctx, { path: p, depth }) => {
      const { abs, rel } = resolveInWorkspace(ctx.workspaceDir, p ?? ".");
      const st = await fs.stat(abs).catch(() => null);
      if (!st) return fail(`${rel} does not exist in the workspace.`);
      if (!st.isDirectory()) return fail(`${rel} is a file (${formatSize(st.size)}); use fs_read to read it.`);
      const lines: string[] = [];
      await listTree(abs, rel, 0, depth ?? 1, lines, { left: 500 });
      return ok(`${rel === "." ? "workspace" : rel}/ (${ctx.workspaceDir})\n${lines.length ? lines.join("\n") : "(empty)"}`);
    },
  ),
];
