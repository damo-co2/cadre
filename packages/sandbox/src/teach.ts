/**
 * "Teach a task" recorder: while the user drives a screen, every input becomes
 * a TeachEvent (clicks with a description of the element under the pointer,
 * coalesced typing/scrolling, key presses, navigations) and a JPEG frame is
 * captured after the moments that matter. Written to an output directory.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import { TEACH_MAX_FRAMES, TEACH_MAX_MS, type ScreenInput, type TeachEvent, type TeachRecording } from "@grokbot/shared";

export interface TeachRecorderOptions {
  id: string;
  botId: string;
  description: string;
  /** Absolute directory; frames and events.json are written here. */
  outDir: string;
  page: () => Page | null;
  /** Called (throttled to 2/s) whenever the event count changes. */
  onChange: () => void;
  /** Called once when TEACH_MAX_MS elapses. */
  onAutoStop: () => void;
}

const TYPE_IDLE_MS = 1500;
const SCROLL_IDLE_MS = 800;
const NAV_DEDUPE_MS = 1000;
const EMIT_INTERVAL_MS = 500;
const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock", "NumLock", "ScrollLock", "Fn", "AltGraph", "ControlOrMeta", "OS", "Dead", "Unidentified"]);

/** Runs in the page: one-line description of an element (tag#id role "name" [ref]). */
const DESCRIBE_SCRIPT = String.raw`(arg) => {
  const el = arg.x === undefined ? document.activeElement : document.elementFromPoint(arg.x, arg.y);
  if (!el || el === document.documentElement) return arg.x === undefined ? "nothing focused" : "nothing at (" + arg.x + "," + arg.y + ")";
  const collapse = (s) => (s || "").replace(/\s+/g, " ").trim();
  const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
  const tag = el.tagName.toLowerCase();
  let role = el.getAttribute("role") || "";
  if (!role) {
    if (tag === "a" && el.hasAttribute("href")) role = "link";
    else if (tag === "button" || tag === "summary") role = "button";
    else if (tag === "select") role = "combobox";
    else if (tag === "textarea") role = "textbox";
    else if (tag === "input") {
      const t = (el.type || "text").toLowerCase();
      role = t === "checkbox" || t === "radio" ? t : t === "submit" || t === "button" || t === "reset" || t === "image" ? "button" : "textbox";
    } else if (el.isContentEditable) role = "textbox";
  }
  let name = collapse(el.getAttribute("aria-label"));
  if (!name && el.labels && el.labels.length) name = collapse(Array.from(el.labels).map((l) => l.textContent).join(" "));
  if (!name && tag === "input" && (el.type === "submit" || el.type === "button" || el.type === "reset")) name = collapse(el.value);
  if (!name) name = collapse(el.getAttribute("placeholder"));
  if (!name) name = collapse(el.textContent);
  if (!name) name = collapse(el.getAttribute("alt") || el.getAttribute("title") || el.getAttribute("name"));
  const ref = el.getAttribute("data-gb-ref") || (el.closest && el.closest("[data-gb-ref]") ? el.closest("[data-gb-ref]").getAttribute("data-gb-ref") : "");
  let out = tag + (el.id ? "#" + el.id : "");
  if (tag === "input" && el.type && el.type !== "text") out += "[type=" + el.type + "]";
  if (role && role !== tag) out += " role=" + role;
  if (name) out += ' "' + clip(name, 80).replace(/"/g, "'") + '"';
  if (ref) out += " [" + ref + "]";
  return out;
}`;

export class TeachRecorder {
  readonly id: string;
  readonly botId: string;
  readonly description: string;
  readonly outDir: string;
  readonly startedAt: Date;
  private readonly events: TeachEvent[] = [];
  private readonly frames: string[] = [];
  private stopped = false;
  private pendingType: { text: string; target: string; timer: NodeJS.Timeout } | null = null;
  private pendingScroll: { deltaY: number; timer: NodeJS.Timeout } | null = null;
  private lastNav: { url: string; at: number; event: Extract<TeachEvent, { kind: "navigate" }>; framed: boolean } | null = null;
  private captureChain: Promise<void> = Promise.resolve();
  private lastEmit = 0;
  private emitTimer: NodeJS.Timeout | null = null;
  private readonly autoStopTimer: NodeJS.Timeout;

  constructor(private readonly opts: TeachRecorderOptions) {
    this.id = opts.id;
    this.botId = opts.botId;
    this.description = opts.description;
    this.outDir = opts.outDir;
    this.startedAt = new Date();
    this.autoStopTimer = setTimeout(() => opts.onAutoStop(), TEACH_MAX_MS);
  }

  get eventCount(): number {
    return this.events.length;
  }

  private now(): number {
    return Date.now() - this.startedAt.getTime();
  }

  // ---------- input hooks (called by ScreenManager.input) ----------

  /** Wraps the dispatch of one ScreenInput so targets are read before and frames after. */
  async wrap(input: ScreenInput, dispatch: () => Promise<void>): Promise<void> {
    if (this.stopped) return dispatch();
    switch (input.kind) {
      case "mouse": {
        if (input.action !== "down" && input.action !== "click" && input.action !== "dblclick") return dispatch();
        this.flushType();
        this.flushScroll();
        const target = await this.describe({ x: input.x, y: input.y });
        const url = this.opts.page()?.url() ?? "";
        await dispatch();
        this.push({ t: this.now(), kind: "click", x: input.x, y: input.y, target, url });
        await this.captureFrame();
        return;
      }
      case "text": {
        await this.appendTyped(input.text, dispatch);
        return;
      }
      case "key": {
        if (input.action !== "press") return dispatch();
        if (MODIFIER_KEYS.has(input.key)) return dispatch();
        const mods = input.modifiers ?? [];
        if (input.key.length === 1 && mods.length === 0) {
          await this.appendTyped(input.key, dispatch);
          return;
        }
        this.flushType();
        this.flushScroll();
        await dispatch();
        this.push({ t: this.now(), kind: "key", key: [...mods, input.key].join("+") });
        return;
      }
      case "wheel": {
        this.flushType();
        await dispatch();
        if (this.pendingScroll) {
          clearTimeout(this.pendingScroll.timer);
          this.pendingScroll.deltaY += input.deltaY;
          this.pendingScroll.timer = setTimeout(() => this.flushScroll(), SCROLL_IDLE_MS);
        } else {
          this.pendingScroll = { deltaY: input.deltaY, timer: setTimeout(() => this.flushScroll(), SCROLL_IDLE_MS) };
        }
        return;
      }
      case "navigate": {
        this.flushType();
        this.flushScroll();
        await dispatch();
        const page = this.opts.page();
        if (page) {
          const title = await page.title().catch(() => "");
          this.onNavigated(page.url(), title);
          await this.frameForNavigation();
        }
        return;
      }
    }
  }

  private async appendTyped(text: string, dispatch: () => Promise<void>): Promise<void> {
    this.flushScroll();
    const target = this.pendingType ? this.pendingType.target : await this.describe({});
    await dispatch();
    if (this.pendingType && this.pendingType.target === target) {
      clearTimeout(this.pendingType.timer);
      this.pendingType.text += text;
      this.pendingType.timer = setTimeout(() => this.flushType(), TYPE_IDLE_MS);
    } else {
      this.flushType();
      this.pendingType = { text, target, timer: setTimeout(() => this.flushType(), TYPE_IDLE_MS) };
    }
  }

  /** Main-frame navigation (from framenavigated or an explicit navigate input). Dedupes the same url within 1 s. */
  onNavigated(url: string, title: string): void {
    if (this.stopped || url === "about:blank") return;
    const at = Date.now();
    if (this.lastNav && this.lastNav.url === url && at - this.lastNav.at < NAV_DEDUPE_MS) {
      if (title && !this.lastNav.event.title) {
        this.lastNav.event.title = title;
        this.scheduleEmit();
      }
      return;
    }
    this.flushType();
    this.flushScroll();
    const event: Extract<TeachEvent, { kind: "navigate" }> = { t: this.now(), kind: "navigate", url, title };
    this.lastNav = { url, at, event, framed: false };
    this.push(event);
  }

  /** Main-frame load: fill in the title and capture one frame for the latest navigation. */
  async onLoaded(url: string, title: string): Promise<void> {
    if (this.stopped) return;
    if (!this.lastNav || this.lastNav.url !== url) this.onNavigated(url, title);
    else if (title && this.lastNav.event.title !== title) {
      this.lastNav.event.title = title;
      this.scheduleEmit();
    }
    await this.frameForNavigation();
  }

  private async frameForNavigation(): Promise<void> {
    if (!this.lastNav || this.lastNav.framed) return;
    this.lastNav.framed = true;
    await this.captureFrame();
  }

  // ---------- coalescing ----------

  private flushType(): void {
    const p = this.pendingType;
    if (!p) return;
    clearTimeout(p.timer);
    this.pendingType = null;
    this.push({ t: this.now(), kind: "type", text: p.text, target: p.target });
    void this.captureFrame();
  }

  private flushScroll(): void {
    const p = this.pendingScroll;
    if (!p) return;
    clearTimeout(p.timer);
    this.pendingScroll = null;
    if (p.deltaY !== 0) this.push({ t: this.now(), kind: "scroll", deltaY: Math.round(p.deltaY) });
  }

  private push(ev: TeachEvent): void {
    if (this.stopped) return;
    this.events.push(ev);
    this.scheduleEmit();
  }

  private scheduleEmit(): void {
    if (this.stopped) return;
    const since = Date.now() - this.lastEmit;
    if (since >= EMIT_INTERVAL_MS) {
      this.lastEmit = Date.now();
      this.opts.onChange();
    } else if (!this.emitTimer) {
      this.emitTimer = setTimeout(() => {
        this.emitTimer = null;
        this.lastEmit = Date.now();
        if (!this.stopped) this.opts.onChange();
      }, EMIT_INTERVAL_MS - since);
    }
  }

  // ---------- frames ----------

  private async describe(arg: { x?: number; y?: number }): Promise<string> {
    const page = this.opts.page();
    if (!page) return "no page";
    try {
      return (await page.evaluate(`(${DESCRIBE_SCRIPT})(${JSON.stringify(arg)})`)) as string;
    } catch {
      return arg.x === undefined ? "unknown element" : `unknown element at (${arg.x},${arg.y})`;
    }
  }

  /** Serialised, best-effort JPEG capture; silently stops at TEACH_MAX_FRAMES. */
  private captureFrame(): Promise<void> {
    if (this.stopped || this.frames.length >= TEACH_MAX_FRAMES) return Promise.resolve();
    const page = this.opts.page();
    if (!page) return Promise.resolve();
    const index = this.frames.length;
    const file = path.join(this.outDir, `frame-${String(index).padStart(3, "0")}.jpg`);
    this.frames.push(file);
    this.captureChain = this.captureChain.then(async () => {
      try {
        const buf = await page.screenshot({ type: "jpeg", quality: 50, timeout: 5_000 });
        await fs.writeFile(file, buf);
      } catch {
        const i = this.frames.indexOf(file);
        if (i >= 0) this.frames.splice(i, 1);
      }
    });
    return this.captureChain;
  }

  // ---------- stop ----------

  async stop(): Promise<TeachRecording> {
    if (!this.stopped) {
      this.flushType();
      this.flushScroll();
      this.stopped = true;
      clearTimeout(this.autoStopTimer);
      if (this.emitTimer) clearTimeout(this.emitTimer);
    }
    await this.captureChain;
    const recording: TeachRecording = {
      id: this.id,
      botId: this.botId,
      description: this.description,
      startedAt: this.startedAt.toISOString(),
      endedAt: new Date().toISOString(),
      events: this.events,
      frames: [...this.frames],
    };
    await fs.mkdir(this.outDir, { recursive: true });
    await fs.writeFile(path.join(this.outDir, "events.json"), JSON.stringify(recording, null, 2), "utf8");
    return recording;
  }
}
