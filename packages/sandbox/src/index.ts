/**
 * @grokbot/sandbox: the Bots' shared computer. Each Bot gets its own screen
 * (a Chromium context) plus a shared shell and workspace folder. Tools are
 * exposed once as specs (for API drivers) and as an MCP server (for CLI drivers).
 */
import { mkdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { COMPUTER_TOOL_NAMES, SCREEN_SIZE, type ComputerToolName, type ScreenInput, type ScreenState, type TeachRecording } from "@grokbot/shared";
import { ScreenManager, type ScreenFrame } from "./screen.js";
import {
  assertPresent,
  browserTools,
  describeError,
  fail,
  ok,
  pageHeader,
  resolveTarget,
  settle,
  type ToolCallResult,
  type ToolContext,
  type ToolDef,
  type ToolSpec,
} from "./tools.js";
import { shellAndFsTools } from "./shell.js";

export type { ToolCallResult, ToolContent, ToolSpec } from "./tools.js";
export type { ScreenFrame } from "./screen.js";
export { createMcpServer } from "./mcp.js";
export { canConfine } from "./shell.js";

export interface ComputerOptions {
  /** Folder the shell runs in and fs_* tools are confined to (created if missing). */
  workspaceDir: string;
  /** Run Chromium headless (default true). */
  headless?: boolean;
  /** Screen size (default SCREEN_SIZE). */
  viewport?: { width: number; height: number };
}

export interface CallToolOptions {
  signal?: AbortSignal;
  /** shell_run only: run with writes confined to this folder (Auto Review decided it may run unasked). */
  confineTo?: string;
}

export class ComputerService {
  readonly workspaceDir: string;
  private readonly viewport: { width: number; height: number };
  private readonly screens: ScreenManager;
  private readonly tools = new Map<string, ToolDef>();
  private readonly locks = new Map<string, Promise<void>>();

  constructor(opts: ComputerOptions) {
    let ws = path.resolve(opts.workspaceDir);
    mkdirSync(ws, { recursive: true });
    try {
      ws = realpathSync(ws);
    } catch {
      /* keep the resolved path */
    }
    this.workspaceDir = ws;
    this.viewport = opts.viewport ?? { ...SCREEN_SIZE };
    this.screens = new ScreenManager({ headless: opts.headless ?? true, viewport: this.viewport });
    for (const t of [...browserTools, ...shellAndFsTools]) this.tools.set(t.name, t);
    for (const name of COMPUTER_TOOL_NAMES) {
      if (!this.tools.has(name)) throw new Error(`sandbox: tool ${name} is declared in COMPUTER_TOOL_NAMES but not implemented`);
    }
  }

  /** Tool specs in COMPUTER_TOOL_NAMES order. */
  listTools(): ToolSpec[] {
    return COMPUTER_TOOL_NAMES.map((name) => {
      const { run: _run, ...spec } = this.tools.get(name)!;
      return spec;
    });
  }

  /**
   * Run one tool on a Bot's screen. Validates input, serialises calls per Bot,
   * waits while the user has taken control, and never throws for tool failures.
   */
  async callTool(botId: string, name: string, input: unknown, opts: CallToolOptions = {}): Promise<ToolCallResult> {
    const tool = this.tools.get(name);
    if (!tool) return fail(`Unknown tool "${name}". Available tools: ${COMPUTER_TOOL_NAMES.join(", ")}.`);

    // Hidden runtime-only field: extra environment for shell_run (Vault secrets).
    // Pulled off before validation so it never appears in schemas, errors or echoes.
    let env: Record<string, string> | undefined;
    let raw: unknown = input ?? {};
    if (name === "shell_run" && raw && typeof raw === "object" && "_env" in raw) {
      const { _env, ...rest } = raw as { _env?: unknown } & Record<string, unknown>;
      raw = rest;
      if (_env && typeof _env === "object" && !Array.isArray(_env)) {
        env = Object.fromEntries(Object.entries(_env as Record<string, unknown>).map(([k, v]) => [k, String(v)]));
      }
    }

    const parsed = z.object(tool.zodShape).safeParse(raw);
    if (!parsed.success) return fail(`Invalid input for ${name}: ${z.prettifyError(parsed.error)}`);

    return this.runOnScreen(botId, name, opts.signal, (ctx) => tool.run({ ...ctx, env, confineTo: name === "shell_run" ? opts.confineTo : undefined }, parsed.data as Record<string, unknown>));
  }

  /**
   * Fill a field with a secret the model must never see (called by the runtime
   * after resolving a Vault entry). Behaves like browser_type (clear, fill,
   * optional Enter) but the value is never echoed in results or errors.
   * Not an MCP tool and not in listTools().
   */
  async fillSecret(
    botId: string,
    target: { ref?: string; selector?: string },
    value: string,
    opts: { submit?: boolean; signal?: AbortSignal } = {},
  ): Promise<ToolCallResult> {
    if (!target.ref && !target.selector) return fail("fillSecret failed: provide a ref (from browser_read_page) or a CSS selector for the field.");
    const scrub = (text: string) => (value.length > 0 ? text.split(value).join("***") : text);
    const result = await this.runOnScreen(botId, "fillSecret", opts.signal, async (ctx) => {
      const page = await ctx.page();
      const { locator, label } = resolveTarget(page, { ref: target.ref, selector: target.selector });
      await assertPresent(locator, label);
      await locator.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => {});
      await locator.fill(value, { timeout: 10_000 });
      if (opts.submit) {
        await locator.press("Enter", { timeout: 5_000 });
        await settle(page, 3_000);
      }
      return ok(`Filled ${label} with a secret (${value.length} characters)${opts.submit ? " and pressed Enter" : ""}. Now at ${await pageHeader(page)}`);
    });
    return { ...result, content: result.content.map((c) => (c.type === "text" ? { ...c, text: scrub(c.text) } : c)) };
  }

  /** Shared wrapper: per-bot mutex, wait for user control, busy flag, error mapping. */
  private runOnScreen(
    botId: string,
    name: string,
    signal: AbortSignal | undefined,
    fn: (ctx: ToolContext) => Promise<ToolCallResult>,
  ): Promise<ToolCallResult> {
    return this.withLock(botId, async () => {
      try {
        await this.screens.waitUntilReleased(botId, signal);
      } catch (e) {
        return fail(`${name} did not run: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (signal?.aborted) return fail(`${name} did not run: the call was cancelled.`);

      this.screens.patch(botId, { busy: true });
      const ctx: ToolContext = {
        page: () => this.screens.ensurePage(botId),
        workspaceDir: this.workspaceDir,
        viewport: this.viewport,
        signal,
      };
      try {
        return await fn(ctx);
      } catch (e) {
        return fail(describeError(name, e));
      } finally {
        await this.screens.refreshMeta(botId).catch(() => {});
        this.screens.patch(botId, { busy: false });
      }
    });
  }

  getState(botId: string): ScreenState {
    return this.screens.getState(botId);
  }

  /** Fires on any state change (status, url, title, busy, control). */
  onState(cb: (state: ScreenState) => void): () => void {
    return this.screens.onState(cb);
  }

  /** Live JPEG frames of a Bot's screen; the screencast runs only while someone watches. */
  watch(botId: string, onFrame: (frame: ScreenFrame) => void): () => void {
    return this.screens.watch(botId, onFrame);
  }

  /** Hand the screen to the user (true) or back to the Bot (false). */
  setControl(botId: string, enabled: boolean): Promise<void> {
    return this.screens.setControl(botId, enabled);
  }

  /** Raw mouse/keyboard/navigation input from the desktop's live view. */
  input(botId: string, input: ScreenInput): Promise<void> {
    return this.screens.input(botId, input);
  }

  /**
   * Teach a task: hand the screen to the user and record what they do.
   * Creates the screen if needed; frames (jpeg) and events.json go to outDir.
   */
  startRecording(botId: string, opts: { id: string; description: string; outDir: string }): Promise<void> {
    return this.screens.startRecording(botId, opts);
  }

  /** Stop recording, give the screen back to the Bot, write events.json and return the recording (frames as absolute paths). */
  stopRecording(botId: string): Promise<TeachRecording> {
    return this.screens.stopRecording(botId);
  }

  isRecording(botId: string): boolean {
    return this.screens.isRecording(botId);
  }

  /** Close one screen (or all). Workspace files are kept. */
  reset(botId?: string): Promise<void> {
    return this.screens.reset(botId);
  }

  async shutdown(): Promise<void> {
    await this.screens.shutdown();
  }

  private withLock<T>(botId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(botId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const chained = prev.then(() => gate);
    this.locks.set(botId, chained);
    return prev
      .then(fn)
      .finally(() => {
        release();
        if (this.locks.get(botId) === chained) this.locks.delete(botId);
      });
  }
}

export type { ComputerToolName };

/** Guidance for models driving the computer; append to the Bot's system prompt. */
export const COMPUTER_SYSTEM_PROMPT = `You have your own screen on a shared computer: a browser, a shell and a workspace folder. Other Bots have their own screens; yours is private to you.
Browser: start with browser_navigate, then browser_read_page to see the page as an outline with [ref_N] handles. Always read the page before clicking or typing, and target elements by ref rather than guessing selectors.
After every click, type or key press, check the result that comes back (new URL, title, outline). If it is not what you expected, read the page again or take a browser_screenshot before trying something else.
Use browser_find to locate a specific button, link or field on long pages, and browser_get_text to read prose. Refs reset whenever the page navigates, so re-read after navigation.
Scroll with browser_scroll when content is below the fold; many pages load more as you scroll.
Shell: shell_run executes in the workspace folder with your normal environment (git, node, python, curl). Commands are killed at the timeout; cap output is 50 KB, so pipe through head/tail/grep for big logs.
Files: fs_read, fs_write and fs_list work on the sandbox (workspace) folder only. Save deliverables there and tell the user the path.
Only one tool call runs on your screen at a time, so sequence your actions. If the user takes control of your screen, your next call waits until they hand it back.
Never claim something was done (form submitted, file saved, command succeeded) without evidence from a tool result: check exit codes, re-read pages, list files.
Avoid logging in with the user's credentials or entering payment details; ask the user to do that part themselves.
When a page blocks automation or something keeps failing, say so plainly and suggest what the user can do.
Prefer the simplest path: a direct URL over search, a shell command over a long browser flow, one check over three.`;
