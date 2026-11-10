/**
 * Screen manager: one shared Chromium, one BrowserContext + Page per Bot.
 * Owns ScreenState, state change events, the CDP screencast used by the
 * desktop's live view, user control hand-off and raw input dispatch.
 */
import { chromium, type Browser, type BrowserContext, type CDPSession, type Page } from "playwright";
import { promises as fs } from "node:fs";
import type { ScreenInput, ScreenState, TeachRecording } from "@grokbot/shared";
import { TeachRecorder } from "./teach.js";

export interface ScreenFrame {
  /** base64 JPEG */
  data: string;
  width: number;
  height: number;
}
export type FrameListener = (frame: ScreenFrame) => void;
export type StateListener = (state: ScreenState) => void;

export interface ScreenManagerOptions {
  headless: boolean;
  viewport: { width: number; height: number };
}

interface Screen {
  state: ScreenState;
  context: BrowserContext | null;
  page: Page | null;
  cdp: CDPSession | null;
  creating: Promise<Page> | null;
  /** Set while we close the context on purpose so the close event is not treated as a crash. */
  closing: boolean;
  watchers: Set<FrameListener>;
  screencasting: boolean;
  controlWaiters: Set<() => void>;
  recorder: TeachRecorder | null;
}

const CONTROL_WAIT_MS = 30 * 60 * 1000;

export class ScreenManager {
  private browser: Browser | null = null;
  private launching: Promise<Browser> | null = null;
  private userAgent = "";
  private readonly screens = new Map<string, Screen>();
  private readonly listeners = new Set<StateListener>();
  private closed = false;

  constructor(private readonly opts: ScreenManagerOptions) {}

  // ---------- state ----------

  getState(botId: string): ScreenState {
    return { ...this.screen(botId).state };
  }

  onState(cb: StateListener): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  /** Merge fields into a screen's state and notify listeners. */
  patch(botId: string, patch: Partial<ScreenState>): void {
    const s = this.screen(botId);
    Object.assign(s.state, patch);
    this.emit(s);
  }

  /** Re-read url/title from the live page (titles change without navigation in SPAs). */
  async refreshMeta(botId: string): Promise<void> {
    const s = this.screen(botId);
    if (!s.page || s.page.isClosed()) return;
    const url = s.page.url();
    const title = await s.page.title().catch(() => s.state.title ?? "");
    if (url !== s.state.url || title !== s.state.title) {
      s.state.url = url;
      s.state.title = title;
      this.emit(s);
    }
  }

  private screen(botId: string): Screen {
    let s = this.screens.get(botId);
    if (!s) {
      s = {
        state: {
          botId,
          status: "off",
          url: null,
          title: null,
          busy: false,
          controlledByUser: false,
          width: this.opts.viewport.width,
          height: this.opts.viewport.height,
        },
        context: null,
        page: null,
        cdp: null,
        creating: null,
        closing: false,
        watchers: new Set(),
        screencasting: false,
        controlWaiters: new Set(),
        recorder: null,
      };
      this.screens.set(botId, s);
    }
    return s;
  }

  private emit(s: Screen): void {
    const copy = { ...s.state };
    for (const cb of this.listeners) {
      try {
        cb(copy);
      } catch {
        /* listener errors must not break the screen */
      }
    }
  }

  // ---------- browser / page lifecycle ----------

  private async getBrowser(): Promise<Browser> {
    if (this.closed) throw new Error("ComputerService has been shut down");
    if (this.browser?.isConnected()) return this.browser;
    if (this.launching) return this.launching;
    this.launching = (async () => {
      const browser = await chromium.launch({ headless: this.opts.headless });
      const major = browser.version().split(".")[0] ?? "130";
      const os =
        process.platform === "darwin"
          ? "Macintosh; Intel Mac OS X 10_15_7"
          : process.platform === "win32"
            ? "Windows NT 10.0; Win64; x64"
            : "X11; Linux x86_64";
      this.userAgent = `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
      browser.on("disconnected", () => {
        if (this.browser === browser) this.browser = null;
        for (const s of this.screens.values()) this.markLost(s, "browser disconnected");
      });
      this.browser = browser;
      return browser;
    })().finally(() => {
      this.launching = null;
    });
    return this.launching;
  }

  /** Returns the Bot's page, creating the browser/context/page lazily. */
  async ensurePage(botId: string): Promise<Page> {
    const s = this.screen(botId);
    if (s.page && !s.page.isClosed()) return s.page;
    if (s.creating) return s.creating;
    s.creating = this.createPage(s).finally(() => {
      s.creating = null;
    });
    return s.creating;
  }

  private async createPage(s: Screen): Promise<Page> {
    if (s.state.status !== "reconnecting") s.state.status = "starting";
    s.state.error = undefined;
    this.emit(s);
    try {
      const browser = await this.getBrowser();
      const context = await browser.newContext({
        viewport: this.opts.viewport,
        deviceScaleFactor: 1,
        userAgent: this.userAgent,
        locale: "en-US",
        colorScheme: "light",
      });
      const page = await context.newPage();
      s.closing = false;
      page.on("framenavigated", (frame) => {
        if (frame !== page.mainFrame() || s.page !== page) return;
        s.state.url = frame.url();
        this.emit(s);
        s.recorder?.onNavigated(frame.url(), "");
      });
      const updateTitle = () => {
        if (s.page !== page) return;
        page
          .title()
          .then((title) => {
            if (s.page !== page || title === s.state.title) return;
            s.state.title = title;
            this.emit(s);
          })
          .catch(() => {});
      };
      page.on("domcontentloaded", updateTitle);
      page.on("load", updateTitle);
      page.on("load", () => {
        const rec = s.recorder;
        if (!rec || s.page !== page) return;
        page
          .title()
          .catch(() => "")
          .then((title) => rec.onLoaded(page.url(), title))
          .catch(() => {});
      });
      page.on("crash", () => {
        if (s.page === page) this.markLost(s, "page crashed");
      });
      page.on("close", () => {
        if (s.page === page && !s.closing) this.markLost(s, "page closed");
      });
      context.on("close", () => {
        if (s.context === context && !s.closing) this.markLost(s, "context closed");
      });

      const cdp = await context.newCDPSession(page);
      cdp.on("Page.screencastFrame", (ev) => {
        cdp.send("Page.screencastFrameAck", { sessionId: ev.sessionId }).catch(() => {});
        if (s.watchers.size === 0) return;
        const frame: ScreenFrame = {
          data: ev.data,
          width: ev.metadata.deviceWidth,
          height: ev.metadata.deviceHeight,
        };
        for (const cb of s.watchers) {
          try {
            cb(frame);
          } catch {
            /* ignore */
          }
        }
      });

      s.context = context;
      s.page = page;
      s.cdp = cdp;
      s.state.status = "ready";
      s.state.url = page.url();
      s.state.title = "";
      s.state.error = undefined;
      this.emit(s);
      if (s.watchers.size > 0) await this.startScreencast(s);
      return page;
    } catch (e) {
      s.state.status = "error";
      s.state.error = e instanceof Error ? e.message : String(e);
      this.emit(s);
      throw e;
    }
  }

  /** The page/context went away unexpectedly: drop it, recreate on next use. */
  private markLost(s: Screen, reason: string): void {
    s.page = null;
    s.context = null;
    s.cdp = null;
    s.screencasting = false;
    if (this.closed) {
      s.state.status = "off";
    } else {
      s.state.status = "reconnecting";
      s.state.error = reason;
    }
    this.emit(s);
  }

  // ---------- screencast ----------

  watch(botId: string, onFrame: FrameListener): () => void {
    const s = this.screen(botId);
    s.watchers.add(onFrame);
    if (s.watchers.size === 1) {
      this.ensurePage(botId)
        .then(() => this.startScreencast(s))
        .catch(() => {});
    }
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      s.watchers.delete(onFrame);
      if (s.watchers.size === 0) void this.stopScreencast(s);
    };
  }

  private async startScreencast(s: Screen): Promise<void> {
    if (!s.cdp || s.screencasting || s.watchers.size === 0) return;
    s.screencasting = true;
    try {
      await s.cdp.send("Page.startScreencast", {
        format: "jpeg",
        quality: 55,
        maxWidth: this.opts.viewport.width,
        maxHeight: this.opts.viewport.height,
        everyNthFrame: 1,
      });
    } catch {
      s.screencasting = false;
    }
  }

  private async stopScreencast(s: Screen): Promise<void> {
    if (!s.screencasting) return;
    s.screencasting = false;
    await s.cdp?.send("Page.stopScreencast").catch(() => {});
  }

  // ---------- user control ----------

  async setControl(botId: string, enabled: boolean): Promise<void> {
    const s = this.screen(botId);
    if (enabled) await this.ensurePage(botId).catch(() => {});
    if (s.state.controlledByUser === enabled) return;
    s.state.controlledByUser = enabled;
    this.emit(s);
    if (!enabled) this.releaseWaiters(s);
  }

  private releaseWaiters(s: Screen): void {
    const waiters = [...s.controlWaiters];
    s.controlWaiters.clear();
    for (const w of waiters) w();
  }

  /** Blocks while the user holds the screen; gives up after 30 minutes or on abort. */
  async waitUntilReleased(botId: string, signal?: AbortSignal): Promise<void> {
    const s = this.screen(botId);
    const deadline = Date.now() + CONTROL_WAIT_MS;
    while (s.state.controlledByUser) {
      if (this.closed) throw new Error("ComputerService has been shut down");
      if (signal?.aborted) throw new Error("cancelled while waiting for the user to hand the screen back");
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error("the user has had control of this screen for 30 minutes; ask them to click \"I'm done\" and try again");
      }
      await new Promise<void>((resolve) => {
        const cleanup = () => {
          clearTimeout(timer);
          s.controlWaiters.delete(waiter);
          signal?.removeEventListener("abort", waiter);
        };
        const waiter = () => {
          cleanup();
          resolve();
        };
        const timer = setTimeout(waiter, remaining);
        s.controlWaiters.add(waiter);
        signal?.addEventListener("abort", waiter, { once: true });
      });
    }
  }

  // ---------- raw input (from the desktop's live view) ----------

  async input(botId: string, input: ScreenInput): Promise<void> {
    const page = await this.ensurePage(botId);
    const recorder = this.screen(botId).recorder;
    if (recorder) return recorder.wrap(input, () => this.dispatchInput(page, input));
    return this.dispatchInput(page, input);
  }

  private async dispatchInput(page: Page, input: ScreenInput): Promise<void> {
    switch (input.kind) {
      case "mouse": {
        const button = input.button ?? "left";
        const mods = normaliseModifiers(input.modifiers);
        for (const m of mods) await page.keyboard.down(m);
        try {
          switch (input.action) {
            case "move":
              await page.mouse.move(input.x, input.y);
              break;
            case "down":
              await page.mouse.move(input.x, input.y);
              await page.mouse.down({ button });
              break;
            case "up":
              await page.mouse.move(input.x, input.y);
              await page.mouse.up({ button });
              break;
            case "click":
              await page.mouse.click(input.x, input.y, { button });
              break;
            case "dblclick":
              await page.mouse.dblclick(input.x, input.y, { button });
              break;
          }
        } finally {
          for (const m of mods.reverse()) await page.keyboard.up(m);
        }
        return;
      }
      case "wheel":
        await page.mouse.move(input.x, input.y);
        await page.mouse.wheel(input.deltaX, input.deltaY);
        return;
      case "key": {
        const key = [...normaliseModifiers(input.modifiers), normaliseKey(input.key)].join("+");
        if (input.action === "press") await page.keyboard.press(key);
        else if (input.action === "down") await page.keyboard.down(key);
        else await page.keyboard.up(key);
        return;
      }
      case "text":
        await page.keyboard.insertText(input.text);
        return;
      case "navigate":
        await page.goto(withScheme(input.url), { waitUntil: "domcontentloaded", timeout: 20_000 });
        return;
    }
  }

  // ---------- teach a task (recording) ----------

  async startRecording(botId: string, opts: { id: string; description: string; outDir: string }): Promise<void> {
    const s = this.screen(botId);
    if (s.recorder) throw new Error(`screen ${botId} is already recording (${s.recorder.id})`);
    await this.ensurePage(botId);
    await fs.mkdir(opts.outDir, { recursive: true });
    const recorder = new TeachRecorder({
      id: opts.id,
      botId,
      description: opts.description,
      outDir: opts.outDir,
      page: () => (s.page && !s.page.isClosed() ? s.page : null),
      onChange: () => {
        if (s.recorder !== recorder || !s.state.recording) return;
        s.state.recording = { ...s.state.recording, events: recorder.eventCount };
        this.emit(s);
      },
      onAutoStop: () => {
        if (s.recorder === recorder) this.stopRecording(botId).catch(() => {});
      },
    });
    s.recorder = recorder;
    s.state.controlledByUser = true;
    s.state.recording = { id: opts.id, startedAt: recorder.startedAt.toISOString(), events: 0, description: opts.description };
    this.emit(s);
    // Seed the recording with where the user starts (event + first frame).
    if (s.page && s.page.url() !== "about:blank") {
      const title = await s.page.title().catch(() => "");
      await recorder.onLoaded(s.page.url(), title);
    }
  }

  async stopRecording(botId: string): Promise<TeachRecording> {
    const s = this.screen(botId);
    const recorder = s.recorder;
    if (!recorder) throw new Error(`screen ${botId} is not recording`);
    s.recorder = null;
    const recording = await recorder.stop();
    s.state.recording = null;
    s.state.controlledByUser = false;
    this.emit(s);
    this.releaseWaiters(s);
    return recording;
  }

  isRecording(botId: string): boolean {
    return this.screens.get(botId)?.recorder != null;
  }

  // ---------- teardown ----------

  async reset(botId?: string): Promise<void> {
    const targets = botId ? [this.screen(botId)] : [...this.screens.values()];
    await Promise.all(targets.map((s) => this.closeScreen(s)));
    if (!this.closed) {
      for (const s of targets) {
        if (s.watchers.size > 0) {
          this.ensurePage(s.state.botId)
            .then(() => this.startScreencast(s))
            .catch(() => {});
        }
      }
    }
  }

  private async closeScreen(s: Screen): Promise<void> {
    if (s.creating) await s.creating.catch(() => {});
    if (s.recorder) await this.stopRecording(s.state.botId).catch(() => {});
    s.closing = true;
    const ctx = s.context;
    s.page = null;
    s.context = null;
    s.cdp = null;
    s.screencasting = false;
    s.state.status = "off";
    s.state.url = null;
    s.state.title = null;
    s.state.busy = false;
    s.state.controlledByUser = false;
    s.state.recording = null;
    s.state.error = undefined;
    this.emit(s);
    this.releaseWaiters(s);
    await ctx?.close().catch(() => {});
    s.closing = false;
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    await this.reset();
    const browser = this.browser ?? (await this.launching?.catch(() => null)) ?? null;
    this.browser = null;
    await browser?.close().catch(() => {});
  }
}

const MODIFIER_NAMES: Record<string, string> = {
  ctrl: "Control",
  control: "Control",
  shift: "Shift",
  alt: "Alt",
  option: "Alt",
  meta: "Meta",
  cmd: "Meta",
  command: "Meta",
};

function normaliseModifiers(mods: string[] | undefined): string[] {
  const out: string[] = [];
  for (const m of mods ?? []) {
    const name = MODIFIER_NAMES[m.toLowerCase()];
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

/** Map DOM KeyboardEvent.key values to Playwright key names. */
function normaliseKey(key: string): string {
  if (key === " " || key === "Spacebar") return "Space";
  if (key === "Esc") return "Escape";
  return key;
}

export function withScheme(url: string): string {
  const u = url.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(u)) return u;
  return `https://${u}`;
}
