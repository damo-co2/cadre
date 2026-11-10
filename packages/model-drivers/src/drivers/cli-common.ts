import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";

export interface SpawnJsonlOptions {
  bin: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
  signal?: AbortSignal;
}

export interface JsonlLine {
  json?: unknown;
  raw: string;
  stream: "stdout" | "stderr";
}

/** Spawn a CLI and yield each stdout line parsed as JSON (stderr lines are yielded raw). */
export async function* spawnJsonl(opts: SpawnJsonlOptions): AsyncGenerator<JsonlLine, { code: number | null }> {
  const cwd = opts.cwd && existsSync(opts.cwd) ? opts.cwd : undefined;
  const child: ChildProcessWithoutNullStreams = spawn(opts.bin, opts.args, {
    cwd,
    env: { ...process.env, ...opts.env },
    stdio: ["pipe", "pipe", "pipe"],
  });

  // Model CLIs start helper processes (Codex's code-mode host, OpenCode's server) that can keep
  // stdout open after the CLI itself dies. Kill the children too, and stop waiting shortly after.
  const killTree = () => {
    // Children first (synchronously): once the parent dies they are re-parented and unfindable.
    if (child.pid) {
      try {
        execFileSync("pkill", ["-TERM", "-P", String(child.pid)], { stdio: "ignore" });
      } catch {
        /* no children */
      }
    }
    child.kill("SIGTERM");
  };
  const finishSoon = () =>
    setTimeout(() => {
      if (closed) return;
      closed = true;
      resolveWait?.();
      resolveWait = null;
    }, 2000).unref();
  const onAbort = () => {
    killTree();
    finishSoon();
  };
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  if (opts.stdin !== undefined) child.stdin.end(opts.stdin);
  else child.stdin.end();

  const queue: JsonlLine[] = [];
  let resolveWait: (() => void) | null = null;
  let closed = false;
  let exitCode: number | null = null;
  const push = (line: JsonlLine) => {
    queue.push(line);
    resolveWait?.();
    resolveWait = null;
  };

  createInterface({ input: child.stdout }).on("line", (raw) => {
    const trimmed = raw.trim();
    if (!trimmed) return;
    try {
      push({ json: JSON.parse(trimmed), raw, stream: "stdout" });
    } catch {
      push({ raw, stream: "stdout" });
    }
  });
  createInterface({ input: child.stderr }).on("line", (raw) => push({ raw, stream: "stderr" }));

  child.on("exit", (code) => {
    exitCode = code;
    finishSoon();
  });
  child.on("close", (code) => {
    closed = true;
    exitCode = code;
    resolveWait?.();
    resolveWait = null;
  });
  child.on("error", (err) => {
    push({ json: { type: "error", message: `Could not start ${opts.bin}: ${err.message}` }, raw: err.message, stream: "stderr" });
    closed = true;
    exitCode = -1;
    resolveWait?.();
    resolveWait = null;
  });

  try {
    while (true) {
      if (queue.length) {
        yield queue.shift()!;
        continue;
      }
      if (closed) break;
      await new Promise<void>((r) => (resolveWait = r));
    }
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
    if (child.exitCode === null) killTree();
  }
  return { code: exitCode };
}

export async function which(bin: string): Promise<string | null> {
  const { execFile } = await import("node:child_process");
  return new Promise((resolve) => {
    execFile(process.platform === "win32" ? "where" : "which", [bin], (err, stdout) => {
      resolve(err ? null : stdout.trim().split("\n")[0] || null);
    });
  });
}

export async function execText(bin: string, args: string[], timeoutMs = 8000, env?: Record<string, string>): Promise<{ code: number; out: string }> {
  const { execFile } = await import("node:child_process");
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs, env: { ...process.env, ...env }, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = (err as { code?: number } | null)?.code;
      resolve({ code: typeof code === "number" ? code : err ? 1 : 0, out: `${stdout}${stderr}` });
    });
  });
}

/** Render the conversation as a single prompt for CLIs that are driven turn-by-turn without --resume. */
export function transcriptPrompt(system: string, messages: { role: string; content: string }[]): string {
  const lines = [system.trim(), "", "Conversation so far:"];
  for (const m of messages) lines.push(`${m.role === "user" ? "User" : "Assistant"}: ${m.content}`);
  lines.push("", "Reply to the last user message as the assistant. Output only the reply.");
  return lines.join("\n");
}
