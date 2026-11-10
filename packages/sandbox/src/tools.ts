/**
 * Browser tools: specs (zod shape + JSON Schema + LLM-facing description) and
 * implementations on top of a Playwright Page. Shared tool types live here too.
 */
import { z } from "zod";
import type { Locator, Page } from "playwright";
import type { ComputerToolName } from "@grokbot/shared";
import { withScheme } from "./screen.js";

export type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface ToolCallResult {
  content: ToolContent[];
  isError?: boolean;
}

export interface ToolSpec {
  name: ComputerToolName;
  description: string;
  /** JSON Schema object (for API tool definitions). */
  inputSchema: Record<string, unknown>;
  /** The same schema as a zod v4 raw shape (for MCP registerTool). */
  zodShape: Record<string, z.ZodTypeAny>;
}

/** What a tool implementation gets to work with. */
export interface ToolContext {
  /** Lazily creates the Bot's page. */
  page(): Promise<Page>;
  workspaceDir: string;
  viewport: { width: number; height: number };
  signal?: AbortSignal;
  /** Extra environment for shell_run, injected by the runtime (never by the model). */
  env?: Record<string, string>;
  /** shell_run: confine the command's writes to this folder with the macOS sandbox (set by the runtime). */
  confineTo?: string;
}

export interface ToolDef extends ToolSpec {
  run(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolCallResult>;
}

/** Thrown by tool code for user-facing failures; the message already contains a suggestion. */
export class ToolError extends Error {}

export const ok = (text: string, extra: ToolContent[] = []): ToolCallResult => ({
  content: [{ type: "text", text }, ...extra],
});
export const fail = (text: string): ToolCallResult => ({ content: [{ type: "text", text }], isError: true });

export function defineTool<S extends Record<string, z.ZodTypeAny>>(
  name: ComputerToolName,
  description: string,
  shape: S,
  run: (ctx: ToolContext, args: z.infer<z.ZodObject<S>>) => Promise<ToolCallResult>,
): ToolDef {
  const schema = z.toJSONSchema(z.object(shape), { io: "input" }) as Record<string, unknown>;
  delete schema.$schema;
  return {
    name,
    description,
    inputSchema: schema,
    zodShape: shape,
    run: (ctx, args) => run(ctx, args as z.infer<z.ZodObject<S>>),
  };
}

/** Turn an arbitrary failure into one line the model can act on. */
export function describeError(tool: string, e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (e instanceof ToolError) return `${tool} failed: ${msg}`;
  const first = msg.split("\n")[0] ?? msg;
  let hint = "";
  if (/Timeout|timed? ?out/i.test(msg)) {
    hint = "The page or element did not respond in time. Call browser_screenshot or browser_read_page to see the current state, then retry with a fresh ref.";
  } else if (/strict mode violation/i.test(msg)) {
    hint = "The selector matched several elements. Use a [ref_N] from browser_read_page instead.";
  } else if (/ERR_NAME_NOT_RESOLVED/.test(msg)) {
    hint = "DNS lookup failed: check the hostname in the URL.";
  } else if (/ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET/.test(msg)) {
    hint = "Nothing is listening at that address, or the connection was dropped. Check the URL/port and try again.";
  } else if (/ERR_INTERNET_DISCONNECTED/.test(msg)) {
    hint = "The computer appears to be offline.";
  } else if (/has been closed|Target closed|browser disconnected/i.test(msg)) {
    hint = "The screen was closed and will be recreated on the next call; simply retry (you may need to navigate again).";
  } else if (/not (visible|attached)|intercepts pointer events|outside of the viewport/i.test(msg)) {
    hint = "The element is not clickable right now (hidden, covered or off-screen). Scroll to it or close whatever overlays it, then read the page again.";
  } else if (/Cannot type text into|not an <input>|Element is not an/i.test(msg)) {
    hint = "That element does not accept typed text. Target an input, textarea or contenteditable element, or click it first.";
  }
  return `${tool} failed: ${first}${hint ? `\n${hint}` : ""}`;
}

// ---------- page outline (accessibility-style) ----------

interface OutlineOptions {
  filter: "interactive" | "all";
}

/**
 * Runs inside the page. Walks the DOM, assigns stable data-gb-ref attributes to
 * interactive elements and returns one line per meaningful node.
 * Kept as plain JS source (not a TS function) so that transpilers such as
 * tsx/esbuild cannot inject helpers (`__name`) that do not exist in the page.
 */
const OUTLINE_SCRIPT = String.raw`(opts) => {
  const INLINE = new Set(["SPAN","B","I","EM","STRONG","SMALL","CODE","ABBR","TIME","MARK","SUB","SUP","U","S",
    "FONT","BDI","BDO","KBD","SAMP","VAR","CITE","Q","DFN","WBR","BR","DEL","INS"]);
  const SKIP = new Set(["SCRIPT","STYLE","NOSCRIPT","TEMPLATE","SVG","HEAD","META","LINK","TITLE","IFRAME","CANVAS",
    "VIDEO","AUDIO","OBJECT","EMBED","SOURCE","TRACK","MAP"]);
  const BLOCK_LABELS = new Set(["P","LI","TD","TH","DT","DD","BLOCKQUOTE","PRE","LABEL","FIGCAPTION","LEGEND","CAPTION"]);
  const PASSIVE_ROLES = new Set(["presentation","none","group","region","list","listitem","navigation","main","banner",
    "contentinfo","complementary","form","search","article","heading","img","table","row","cell","rowgroup",
    "columnheader","rowheader","status","alert","dialog","toolbar","tablist","menu","menubar","listbox","tree","grid",
    "radiogroup","separator","generic","document","paragraph","note","figure","feed","log","marquee","timer","tooltip",
    "progressbar","math"]);
  const MAX_LINES = 4000;
  const w = window;
  if (typeof w.__gbNextRef !== "number") w.__gbNextRef = 1;
  const lines = [];
  const collapse = (s) => s.replace(/\s+/g, " ").trim();
  const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
  const q = (s) => '"' + s.replace(/"/g, "'") + '"';

  const isRendered = (el) => {
    if (el.getAttribute("aria-hidden") === "true") return false;
    const st = getComputedStyle(el);
    return st.display !== "none" && st.visibility !== "hidden";
  };
  const hasBox = (el) => {
    if (el.tagName === "OPTION") return true;
    const r = el.getBoundingClientRect();
    return r.width > 0 || r.height > 0;
  };
  const roleOf = (el) => {
    const explicit = el.getAttribute("role");
    if (explicit) {
      const r = explicit.split(/\s+/)[0].toLowerCase();
      return PASSIVE_ROLES.has(r) ? null : r;
    }
    const tag = el.tagName;
    if (tag === "A" || tag === "AREA") return el.hasAttribute("href") ? "link" : null;
    if (tag === "BUTTON") return "button";
    if (tag === "SELECT") return "combobox";
    if (tag === "TEXTAREA") return "textbox";
    if (tag === "SUMMARY") return "button";
    if (tag === "OPTION") return "option";
    if (tag === "INPUT") {
      const t = (el.type || "text").toLowerCase();
      if (t === "hidden") return null;
      if (t === "checkbox") return "checkbox";
      if (t === "radio") return "radio";
      if (t === "button" || t === "submit" || t === "reset" || t === "image") return "button";
      if (t === "range") return "slider";
      if (t === "file") return "file-input";
      if (t === "color") return "color-input";
      if (t === "date" || t === "datetime-local" || t === "time" || t === "month" || t === "week") return "date-input";
      return "textbox";
    }
    if (el.isContentEditable && el.hasAttribute("contenteditable")) return "textbox";
    if (el.hasAttribute("onclick") || (el.getAttribute("tabindex") === "0" && getComputedStyle(el).cursor === "pointer")) return "button";
    return null;
  };
  const nameOf = (el) => {
    const aria = el.getAttribute("aria-label");
    if (aria && collapse(aria)) return collapse(aria);
    const lb = el.getAttribute("aria-labelledby");
    if (lb) {
      const t = collapse(lb.split(/\s+/).map((id) => { const n = document.getElementById(id); return n ? n.textContent || "" : ""; }).join(" "));
      if (t) return t;
    }
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
      if (el.labels && el.labels.length) {
        const t = collapse(Array.from(el.labels).map((l) => l.textContent || "").join(" "));
        if (t) return t;
      }
      if (el instanceof HTMLInputElement) {
        if (el.type === "button" || el.type === "submit" || el.type === "reset") return el.value || el.type;
        if (el.type === "image") return el.alt || "image";
      }
      return el.getAttribute("placeholder") || el.getAttribute("title") || el.getAttribute("name") || el.id || "";
    }
    const text = collapse(el.textContent || "");
    if (text) return text;
    const img = el.querySelector("img[alt], svg[aria-label], [aria-label]");
    if (img) return collapse(img.getAttribute("alt") || img.getAttribute("aria-label") || "");
    return el.getAttribute("title") || "";
  };
  const refFor = (el) => {
    let ref = el.getAttribute("data-gb-ref");
    if (!ref) {
      ref = "ref_" + w.__gbNextRef++;
      el.setAttribute("data-gb-ref", ref);
    }
    return ref;
  };
  const interactiveLine = (el, role) => {
    const bits = [];
    if (el instanceof HTMLInputElement) {
      if (el.type === "checkbox" || el.type === "radio") bits.push(el.checked ? "checked" : "unchecked");
      else if (el.type === "password") bits.push("type=password");
      else if (el.value) bits.push("value=" + q(clip(collapse(el.value), 80)));
      if (el.type === "file") bits.push("type=file");
    } else if (el instanceof HTMLTextAreaElement) {
      if (el.value) bits.push("value=" + q(clip(collapse(el.value), 80)));
    } else if (el instanceof HTMLSelectElement) {
      const sel = el.selectedOptions[0];
      if (sel) bits.push("value=" + q(clip(collapse(sel.textContent || sel.value), 60)));
      const opts = Array.from(el.options).slice(0, 12).map((o) => q(clip(collapse(o.textContent || o.value), 40)));
      if (opts.length) bits.push("options: " + opts.join(", ") + (el.options.length > 12 ? ", …" : ""));
    } else if (el.isContentEditable) {
      const v = collapse(el.textContent || "");
      if (v) bits.push("value=" + q(clip(v, 80)));
    }
    if (el.tagName === "A") {
      const href = el.href;
      if (href && !href.startsWith("javascript:")) bits.push("href=" + q(clip(href, 120)));
    }
    if (el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true") bits.push("disabled");
    const expanded = el.getAttribute("aria-expanded");
    if (expanded) bits.push(expanded === "true" ? "expanded" : "collapsed");
    if (el.getAttribute("aria-checked") && !(el instanceof HTMLInputElement)) bits.push(el.getAttribute("aria-checked") === "true" ? "checked" : "unchecked");
    if (el.getAttribute("aria-selected") === "true" || el.hasAttribute("aria-current")) bits.push("selected");
    if (el.hasAttribute("required")) bits.push("required");
    const name = nameOf(el);
    const fieldLike = role === "textbox" || role === "combobox" || role === "file-input" || role === "date-input";
    const label = clip(name, fieldLike ? 80 : 120);
    return "[" + refFor(el) + "] " + role + " " + q(label) + (bits.length ? " (" + bits.join(", ") + ")" : "");
  };
  const ownText = (el) => {
    let out = "";
    for (const n of Array.from(el.childNodes)) {
      if (n.nodeType === Node.TEXT_NODE) out += n.nodeValue || "";
      else if (n.nodeType === Node.ELEMENT_NODE) {
        if (n.tagName === "BR") out += " ";
        else if (INLINE.has(n.tagName) && !roleOf(n) && isRendered(n)) out += " " + ownText(n) + " ";
      }
    }
    return out;
  };
  const LEAF_TAGS = new Set(["A","BUTTON","SELECT","INPUT","TEXTAREA","SUMMARY"]);
  const LEAF_ROLES = new Set(["button","link","option","menuitem","tab","checkbox","radio","switch"]);
  const walk = (el) => {
    if (lines.length >= MAX_LINES) return;
    if (SKIP.has(el.tagName)) return;
    if (!isRendered(el)) return;
    const role = roleOf(el);
    if (role) {
      if (hasBox(el)) lines.push(interactiveLine(el, role));
      // Interactive elements are leaves (their text is their name), except
      // clickable containers that still hold real controls.
      if (LEAF_TAGS.has(el.tagName)) return;
      if (LEAF_ROLES.has(role) && !el.querySelector("a[href], button, input, textarea, select")) return;
    } else if (opts.filter === "all" && !INLINE.has(el.tagName)) {
      const t = collapse(ownText(el));
      if (t) {
        const tag = el.tagName;
        const label = /^H[1-6]$/.test(tag) ? tag.toLowerCase() : BLOCK_LABELS.has(tag) ? tag.toLowerCase() : "text";
        lines.push(label + " " + q(clip(t, 200)));
      }
    }
    if (el.tagName === "DETAILS" && !el.open) {
      const summary = el.querySelector(":scope > summary");
      if (summary) walk(summary);
      return;
    }
    for (const c of Array.from(el.children)) walk(c);
  };
  if (document.body) walk(document.body);
  if (lines.length >= MAX_LINES) lines.push("… (outline capped)");
  return lines;
}`;

export async function outlineLines(page: Page, filter: "interactive" | "all"): Promise<string[]> {
  if (page.url() === "about:blank") return ["(blank page: nothing loaded yet; call browser_navigate first)"];
  return page.evaluate(`(${OUTLINE_SCRIPT})(${JSON.stringify({ filter } satisfies OutlineOptions)})`) as Promise<string[]>;
}

export async function outline(page: Page, filter: "interactive" | "all", maxChars: number): Promise<string> {
  const lines = await outlineLines(page, filter);
  if (lines.length === 0) return "(no visible content; the page may still be loading or may render into a canvas/iframe. Try browser_screenshot.)";
  return truncateLines(lines, maxChars);
}

export function truncateLines(lines: string[], maxChars: number): string {
  let out = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (out.length + line.length + 1 > maxChars) {
      return `${out}\n… truncated: ${lines.length - i} more lines (${lines.length} total). Use browser_find to locate specific elements, browser_get_text for prose, or raise maxChars.`;
    }
    out += (i ? "\n" : "") + line;
  }
  return out;
}

export async function pageHeader(page: Page): Promise<string> {
  const title = await page.title().catch(() => "");
  const url = page.url();
  return `${title || "(untitled)"} — ${url.length > 300 ? `${url.slice(0, 297)}…` : url}`;
}

export async function settle(page: Page, ms: number): Promise<void> {
  await page.waitForLoadState("networkidle", { timeout: ms }).catch(() => {});
}

export function resolveTarget(page: Page, a: { ref?: string; selector?: string; text?: string }): { locator: Locator; label: string } {
  if (a.ref) {
    const ref = a.ref.startsWith("ref_") ? a.ref : `ref_${a.ref}`;
    return { locator: page.locator(`[data-gb-ref="${ref}"]`).first(), label: ref };
  }
  if (a.selector) return { locator: page.locator(a.selector).first(), label: `selector ${JSON.stringify(a.selector)}` };
  if (a.text) return { locator: page.getByText(a.text, { exact: false }).first(), label: `text ${JSON.stringify(a.text)}` };
  throw new ToolError("Provide one of ref (from browser_read_page/browser_find), selector (CSS) or text (visible text).");
}

export async function assertPresent(locator: Locator, label: string): Promise<void> {
  if ((await locator.count()) === 0) {
    throw new ToolError(`${label} was not found on the current page. Refs are reset on navigation: call browser_read_page or browser_find to get fresh ones.`);
  }
}

// ---------- tool definitions ----------

const refField = z.string().optional().describe("Element ref like \"ref_12\" from browser_read_page or browser_find (preferred).");
const selectorField = z.string().optional().describe("CSS selector; use only when no ref is available.");

export const browserTools: ToolDef[] = [
  defineTool(
    "browser_navigate",
    "Open a URL in this Bot's browser screen and wait for it to load. Returns the page title, final URL and a compact outline of the page (with [ref_N] handles for interactive elements) so you can act on it immediately.",
    { url: z.string().min(1).describe("Absolute URL, e.g. https://example.com. A bare domain is treated as https://.") },
    async (ctx, { url }) => {
      const page = await ctx.page();
      const target = withScheme(url);
      await page.goto(target, { waitUntil: "domcontentloaded", timeout: 20_000 });
      await settle(page, 2_000);
      const body = await outline(page, "all", 6_000);
      return ok(`Opened ${await pageHeader(page)}\n\n${body}`);
    },
  ),

  defineTool(
    "browser_read_page",
    "Read the current page as an accessibility-style outline: headings and text, plus every interactive element as `[ref_N] role \"name\" (value/href/state)`. Use the refs with browser_click, browser_type and browser_scroll. Refs are stable until the page navigates. Call this before clicking or typing, and again after actions that change the page.",
    {
      filter: z.enum(["interactive", "all"]).optional().describe("\"interactive\" lists only clickable/typable elements; \"all\" (default) also includes headings and text."),
      maxChars: z.number().int().min(500).max(100_000).optional().describe("Maximum characters to return (default 12000)."),
    },
    async (ctx, { filter, maxChars }) => {
      const page = await ctx.page();
      const body = await outline(page, filter ?? "all", maxChars ?? 12_000);
      return ok(`${await pageHeader(page)}\n\n${body}`);
    },
  ),

  defineTool(
    "browser_find",
    "Search the current page for elements whose role, name or text contains the query (case-insensitive). Returns up to 20 matching lines in the same `[ref_N] role \"name\"` format as browser_read_page. Handy for long pages: find the button or link you need without reading everything.",
    { query: z.string().min(1).describe("Substring to look for, e.g. \"Sign in\", \"search\", \"Add to cart\".") },
    async (ctx, { query }) => {
      const page = await ctx.page();
      const needle = query.toLowerCase();
      const lines = (await outlineLines(page, "all")).filter((l) => l.toLowerCase().includes(needle));
      if (lines.length === 0) {
        return ok(`No elements match ${JSON.stringify(query)} on ${await pageHeader(page)}. Try a shorter or different word, scroll, or call browser_read_page to see what is there.`);
      }
      const shown = lines.slice(0, 20);
      return ok(`${shown.length}${lines.length > 20 ? ` of ${lines.length}` : ""} match(es) for ${JSON.stringify(query)}:\n${shown.join("\n")}`);
    },
  ),

  defineTool(
    "browser_click",
    "Click an element on the current page. Identify it by ref (best), CSS selector, or visible text. Scrolls it into view first, waits briefly for the page to settle, and returns the new URL/title plus a short outline of the page afterwards so you can verify the effect.",
    {
      ref: refField,
      selector: selectorField,
      text: z.string().optional().describe("Visible text of the element (substring match, first match wins)."),
      button: z.enum(["left", "right", "middle"]).optional().describe("Mouse button (default left)."),
      doubleClick: z.boolean().optional().describe("Double-click instead of single click."),
    },
    async (ctx, args) => {
      const page = await ctx.page();
      const before = page.url();
      const { locator, label } = resolveTarget(page, args);
      await assertPresent(locator, label);
      await locator.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => {});
      const opts = { button: args.button ?? "left", timeout: 10_000 } as const;
      if (args.doubleClick) await locator.dblclick(opts);
      else await locator.click(opts);
      await settle(page, 3_000);
      const navigated = page.url() !== before;
      const body = await outline(page, "all", 3_000);
      return ok(`Clicked ${label}. ${navigated ? "Navigated to" : "Still on"} ${await pageHeader(page)}\n\n${body}`);
    },
  ),

  defineTool(
    "browser_type",
    "Type text into an input, textarea, contenteditable or select. Target it by ref or selector; with no target the currently focused element is used. By default the field is cleared first (clear=false appends). Set submit=true to press Enter afterwards (e.g. search boxes, login forms). For a <select>, the text is matched against option labels.",
    {
      ref: refField,
      selector: selectorField,
      text: z.string().describe("The text to enter."),
      clear: z.boolean().optional().describe("Clear existing content first (default true)."),
      submit: z.boolean().optional().describe("Press Enter after typing (default false)."),
    },
    async (ctx, args) => {
      const page = await ctx.page();
      const clear = args.clear ?? true;
      let label = "the focused element";
      let locator: Locator | null = null;
      if (args.ref || args.selector) {
        const t = resolveTarget(page, args);
        locator = t.locator;
        label = t.label;
        await assertPresent(locator, label);
        const tag = await locator.evaluate((el) => el.tagName).catch(() => "");
        if (tag === "SELECT") {
          const picked = await locator.selectOption({ label: args.text }, { timeout: 5_000 }).catch(() => locator!.selectOption(args.text, { timeout: 5_000 }));
          return ok(`Selected ${JSON.stringify(picked)} in ${label}. Now at ${await pageHeader(page)}`);
        }
        if (clear) {
          await locator.fill(args.text, { timeout: 10_000 });
        } else {
          await locator.click({ timeout: 10_000 });
          await locator.pressSequentially(args.text, { timeout: 10_000 });
        }
      } else {
        const focused = await page.evaluate(() => {
          const el = document.activeElement as HTMLElement | null;
          if (!el || el === document.body) return null;
          return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable;
        });
        if (!focused) throw new ToolError("No text field is focused. Pass a ref or selector for the field, or browser_click it first.");
        if (clear) {
          await page.keyboard.press("ControlOrMeta+a");
          await page.keyboard.press("Backspace");
        }
        await page.keyboard.insertText(args.text);
      }
      if (args.submit) {
        if (locator) await locator.press("Enter", { timeout: 5_000 });
        else await page.keyboard.press("Enter");
        await settle(page, 3_000);
      }
      const shown = args.text.length > 60 ? `${args.text.slice(0, 57)}…` : args.text;
      return ok(`Typed ${JSON.stringify(shown)} into ${label}${args.submit ? " and pressed Enter" : ""}. Now at ${await pageHeader(page)}`);
    },
  ),

  defineTool(
    "browser_press",
    "Press a key or key combination on the current page (sent to the focused element). Use Playwright key names: \"Enter\", \"Escape\", \"Tab\", \"ArrowDown\", \"Backspace\", \"Control+a\", \"Shift+Tab\", \"ControlOrMeta+c\".",
    { key: z.string().min(1).describe("Key name or combo, e.g. \"Enter\" or \"Control+a\".") },
    async (ctx, { key }) => {
      const page = await ctx.page();
      await page.keyboard.press(key);
      await settle(page, 2_000);
      return ok(`Pressed ${key}. Now at ${await pageHeader(page)}`);
    },
  ),

  defineTool(
    "browser_scroll",
    "Scroll the page (or a specific scrollable element given by ref) by a number of pixels. Use it to reveal content below the fold before reading or clicking. Returns the new scroll position.",
    {
      direction: z.enum(["up", "down", "left", "right"]).describe("Scroll direction."),
      amount: z.number().int().min(1).max(20_000).optional().describe("Pixels to scroll (default 600, roughly one screen is 700)."),
      ref: z.string().optional().describe("Scroll inside this element instead of the window (ref from browser_read_page)."),
    },
    async (ctx, { direction, amount, ref }) => {
      const page = await ctx.page();
      const px = amount ?? 600;
      const dx = direction === "left" ? -px : direction === "right" ? px : 0;
      const dy = direction === "up" ? -px : direction === "down" ? px : 0;
      if (ref) {
        const { locator, label } = resolveTarget(page, { ref });
        await assertPresent(locator, label);
        await locator.hover({ timeout: 5_000 });
      } else {
        await page.mouse.move(ctx.viewport.width / 2, ctx.viewport.height / 2);
      }
      await page.mouse.wheel(dx, dy);
      await page.waitForTimeout(250);
      const pos = await page.evaluate(() => ({
        x: Math.round(scrollX),
        y: Math.round(scrollY),
        maxY: Math.max(0, document.documentElement.scrollHeight - innerHeight),
      }));
      const where = pos.maxY === 0 ? "the page does not scroll vertically (content may scroll inside an element; pass its ref)" : `vertical position ${pos.y}/${pos.maxY}${pos.y >= pos.maxY ? " (bottom)" : pos.y === 0 ? " (top)" : ""}`;
      return ok(`Scrolled ${direction} ${px}px${ref ? ` inside ${ref}` : ""}; ${where}. Call browser_read_page to see the newly visible content.`);
    },
  ),

  defineTool(
    "browser_back",
    "Go back to the previous page in this screen's history, like the browser's Back button. Returns the page you land on.",
    {},
    async (ctx) => {
      const page = await ctx.page();
      const res = await page.goBack({ waitUntil: "domcontentloaded", timeout: 20_000 });
      if (!res && page.url() === "about:blank") return fail("There is no previous page in history. Use browser_navigate to open a URL.");
      await settle(page, 2_000);
      const body = await outline(page, "all", 3_000);
      return ok(`Went back to ${await pageHeader(page)}\n\n${body}`);
    },
  ),

  defineTool(
    "browser_get_text",
    "Return the visible text of the current page as plain prose (main/article content first when the page has one). Best for reading articles, docs or search results; use browser_read_page when you need refs to interact.",
    { maxChars: z.number().int().min(200).max(500_000).optional().describe("Maximum characters to return (default 20000).") },
    async (ctx, { maxChars }) => {
      const page = await ctx.page();
      if (page.url() === "about:blank") return fail("Nothing is loaded yet. Call browser_navigate first.");
      const limit = maxChars ?? 20_000;
      const text = await page.evaluate(() => {
        const root = (document.querySelector("main, article, [role=main]") as HTMLElement | null) ?? document.body;
        return (root?.innerText ?? "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
      });
      if (!text) return ok(`${await pageHeader(page)}\n\n(no visible text; the page may still be loading or render into a canvas. Try browser_screenshot.)`);
      const body = text.length > limit ? `${text.slice(0, limit)}\n… truncated (${text.length} chars total; raise maxChars to read more)` : text;
      return ok(`${await pageHeader(page)}\n\n${body}`);
    },
  ),

  defineTool(
    "browser_screenshot",
    "Take a screenshot of the current screen (1280x800 viewport) and return it as an image, with the URL and title. Use it to check layout, charts, images or anything the text outline cannot express; for reading text prefer browser_read_page or browser_get_text.",
    {},
    async (ctx) => {
      const page = await ctx.page();
      let buf = await page.screenshot({ type: "png", timeout: 15_000 });
      let mimeType = "image/png";
      if (buf.byteLength > 600_000) {
        buf = await page.screenshot({ type: "jpeg", quality: 70, timeout: 15_000 });
        mimeType = "image/jpeg";
      }
      return ok(`Screenshot of ${await pageHeader(page)} (${ctx.viewport.width}x${ctx.viewport.height}, ${mimeType})`, [
        { type: "image", data: buf.toString("base64"), mimeType },
      ]);
    },
  ),
];
