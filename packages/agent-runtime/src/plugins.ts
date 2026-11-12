import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";
import type { PluginRow, Store } from "@grokbot/db";
import type {
  AvatarShape,
  BotTemplate,
  InstalledPlugin,
  PluginContents,
  PluginFormat,
  PluginPreview,
  PluginServerInfo,
  PluginSuggestion,
  ServerEvent,
  Skill,
} from "@grokbot/shared";
import { AVATAR_COLORS, AVATAR_SHAPES } from "@grokbot/shared";
import type { ConnectorManager } from "./connectors.js";

/**
 * Plugins: skills, apps (MCP servers) and agents from any agent harness, read straight from a folder.
 *
 * Understands Claude Code plugins and marketplaces (.claude-plugin/), Codex (.codex-plugin/, ~/.codex),
 * Gemini CLI extensions (gemini-extension.json, ~/.gemini), OpenCode (opencode.json, ~/.config/opencode)
 * and plain skills folders (any folder of SKILL.md files, the Agent Skills format they all share).
 *
 *   SKILL.md files, slash commands, AGENTS.md/CLAUDE.md/GEMINI.md → skills every Bot can use
 *   MCP servers (.mcp.json, mcpServers, opencode mcp, codex mcp_servers) → Connect apps entries
 *   agents/*.md → Bot templates you can hire
 *   hooks → not run (listed as skipped)
 *
 * A folder plugin is read live, so edits at the source show up within seconds; a git plugin is
 * Cadre's own shallow clone, refreshed with Update.
 */

const run = promisify(execFile);

export interface ScannedSkill {
  name: string;
  description: string;
  kind: "skill" | "command" | "guide";
  /** The file holding the instructions. */
  file: string;
  /** The skill's own folder (relative paths in it resolve here). */
  dir: string;
  /** The plugin root it came from (${CLAUDE_PLUGIN_ROOT}). */
  root: string;
  /** For TOML commands: the prompt text (the file itself isn't Markdown). */
  prompt?: string;
}

export interface ScannedAgent {
  name: string;
  description: string;
  brief: string;
  file: string;
  skills: string[];
}

export interface ScannedServer {
  key: string;
  transport: "http" | "stdio";
  url: string | null;
  command: string | null;
  args: string[];
  env: Record<string, string>;
  /** Only Authorization is carried over (Cadre's connectors send one auth header). */
  auth: string | null;
  root: string;
  off: boolean;
  notes: string[];
}

export interface PluginScan {
  name: string;
  description: string;
  version: string | null;
  formats: PluginFormat[];
  skills: ScannedSkill[];
  agents: ScannedAgent[];
  servers: ScannedServer[];
  skipped: string[];
}

// ---------- small file helpers ----------

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function readText(p: string, max = 400_000): string | null {
  try {
    const st = statSync(p);
    if (!st.isFile() || st.size > max) return null;
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

/** JSON, tolerating // and /* comments and trailing commas (opencode.jsonc, .vscode/mcp.json). */
function readJson(p: string): Json | null {
  const t = readText(p);
  if (t == null) return null;
  try {
    const v = JSON.parse(t) as unknown;
    return isObj(v) ? v : null;
  } catch {
    try {
      const cleaned = t
        .replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_m, s: string | undefined) => s ?? "")
        .replace(/,(\s*[}\]])/g, "$1");
      const v = JSON.parse(cleaned) as unknown;
      return isObj(v) ? v : null;
    } catch {
      return null;
    }
  }
}

function readToml(p: string): Json | null {
  const t = readText(p);
  if (t == null) return null;
  try {
    const v = parseToml(t) as unknown;
    return isObj(v) ? v : null;
  } catch {
    return null;
  }
}

/** YAML front matter (---) and the Markdown body after it. Bad YAML: empty data, whole text as body. */
export function splitFrontmatter(text: string): { data: Json; body: string } {
  const m = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return { data: {}, body: text };
  try {
    const data = parseYaml(m[1] ?? "") as unknown;
    return { data: isObj(data) ? data : {}, body: text.slice(m[0].length) };
  } catch {
    return { data: {}, body: text.slice(m[0].length) };
  }
}

/** First real line of prose (skips headings, blank lines and code fences). */
function firstLine(body: string): string {
  for (const raw of body.split("\n")) {
    const l = raw.trim();
    if (!l || l.startsWith("#") || l.startsWith("```") || l.startsWith("---") || l.startsWith("<")) continue;
    return l.replace(/^[-*>]\s*/, "");
  }
  return "";
}

const clip = (s: string, n: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** Lowercase letters, digits and dashes (skill and connector names). */
export function slugify(s: string, max = 60): string {
  const out = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/, "");
  return out.length >= 2 ? out : `${out || "x"}-plugin`.slice(0, max);
}

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "__pycache__", ".venv", "venv", "target"]);

/** SKILL.md files under `dir`, up to `depth` folders down. */
function findSkillFiles(dir: string, depth: number): string[] {
  const out: string[] = [];
  const walk = (d: string, left: number) => {
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    if (entries.includes("SKILL.md") && isFile(join(d, "SKILL.md"))) out.push(join(d, "SKILL.md"));
    if (left <= 0) return;
    for (const e of entries.sort()) {
      if (SKIP_DIRS.has(e) || e.startsWith(".")) continue;
      const p = join(d, e);
      if (isDir(p)) walk(p, left - 1);
    }
  };
  walk(dir, depth);
  return out;
}

/** Files with these extensions under `dir` (relative paths), up to `depth` folders down. */
function findFiles(dir: string, exts: string[], depth: number): string[] {
  const out: string[] = [];
  const walk = (d: string, left: number) => {
    let entries: string[];
    try {
      entries = readdirSync(d).sort();
    } catch {
      return;
    }
    for (const e of entries) {
      if (SKIP_DIRS.has(e) || e.startsWith(".")) continue;
      const p = join(d, e);
      if (isDir(p)) {
        if (left > 0) walk(p, left - 1);
      } else if (exts.includes(extname(e).toLowerCase())) out.push(relative(dir, p));
    }
  };
  walk(dir, depth);
  return out;
}

function listFolder(dir: string, max = 30): string[] {
  const out: string[] = [];
  const walk = (d: string, left: number) => {
    let entries: string[];
    try {
      entries = readdirSync(d).sort();
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= max) return;
      if (SKIP_DIRS.has(e) || e.startsWith(".")) continue;
      const p = join(d, e);
      if (isDir(p)) {
        if (left > 0) walk(p, left - 1);
      } else if (e !== "SKILL.md") out.push(relative(dir, p));
    }
  };
  walk(dir, 3);
  return out;
}

const asList = (v: unknown): string[] => (Array.isArray(v) ? v.map(str).filter(Boolean) : typeof v === "string" && v ? [v] : []);

// ---------- variables in app configs ----------

const VAR_RE = /\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}|\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g;
/** Filled in by Cadre itself, never asked for. */
const BUILTIN_VARS = new Set(["CLAUDE_PLUGIN_ROOT", "CLAUDE_PLUGIN_DATA", "CLAUDE_SKILL_DIR", "extensionPath", "workspaceFolder", "HOME", "USER", "PATH", "TMPDIR", "PWD"]);

function varsIn(...values: (string | null | undefined)[]): string[] {
  const out = new Set<string>();
  for (const v of values) {
    if (!v) continue;
    for (const m of v.matchAll(VAR_RE)) {
      const name = m[1] ?? m[3];
      if (name && !BUILTIN_VARS.has(name)) out.add(name);
    }
  }
  return [...out];
}

function substitute(v: string, lookup: (name: string, fallback: string | undefined) => string): string {
  return v.replace(VAR_RE, (_m, a: string | undefined, def: string | undefined, b: string | undefined) => lookup((a ?? b)!, def));
}

export function serverNeeds(s: ScannedServer): string[] {
  return varsIn(s.url, s.command, s.auth, ...s.args, ...Object.values(s.env));
}

// ---------- scanning ----------

const SKILL_DIRS = ["skills", "skill", ".claude/skills", ".opencode/skill", ".opencode/skills", ".codex/skills", ".agents/skills", ".gemini/skills"];
const COMMAND_DIRS = ["commands", "command", "prompts", ".claude/commands", ".opencode/command", ".opencode/commands", ".gemini/commands", ".codex/prompts"];
const AGENT_DIRS = ["agents", "agent", ".claude/agents", ".opencode/agent", ".opencode/agents"];
const GUIDE_FILES = ["AGENTS.md", "CLAUDE.md", "GEMINI.md"];

/** Harness home folders get their product's name (skill names fall back to "<name>-<skill>"). */
const HOME_NAMES: Record<string, string> = {
  ".claude": "Claude Code",
  ".codex": "Codex",
  ".gemini": "Gemini CLI",
  ".config/opencode": "OpenCode",
  ".cursor": "Cursor",
  ".agents/skills": "Agent Skills",
  ".claude/skills": "Claude Code skills",
};

interface ScanCtx {
  scan: PluginScan;
  formats: Set<PluginFormat>;
  seenFiles: Set<string>;
  seenDirs: Set<string>;
  top: string;
}

const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

/** Reads everything Cadre can use from a plugin, marketplace, harness home or skills folder. */
export function scanPluginFolder(folder: string): PluginScan {
  let root = real(folder);
  if (isFile(root)) {
    if (basename(root) !== "SKILL.md") throw new Error("Pick a folder (or a SKILL.md file).");
    root = dirname(root);
  }
  if (!isDir(root)) throw new Error(`No folder at ${folder}`);
  const scan: PluginScan = { name: basename(root), description: "", version: null, formats: [], skills: [], agents: [], servers: [], skipped: [] };
  const ctx: ScanCtx = { scan, formats: new Set(), seenFiles: new Set(), seenDirs: new Set(), top: root };
  scanDir(ctx, root, 0);
  if (scan.name === basename(root)) scan.name = HOME_NAMES[`${basename(dirname(root))}/${basename(root)}`] ?? HOME_NAMES[basename(root)] ?? scan.name;
  if (scan.skills.some((s) => s.kind === "skill") && ctx.formats.size === 0) ctx.formats.add("skills-folder");
  scan.formats = [...ctx.formats];
  // Names unique inside the plugin (a marketplace can hold two "review" skills).
  const used = new Set<string>();
  for (const s of scan.skills) {
    let n = s.name;
    for (let i = 2; used.has(n); i++) n = `${s.name}-${i}`;
    s.name = n;
    used.add(n);
  }
  return scan;
}

function setIdentity(ctx: ScanCtx, dir: string, m: Json) {
  if (dir !== ctx.top) return;
  if (m.name) ctx.scan.name = str(m.name);
  if (m.description) ctx.scan.description = clip(str(m.description), 300);
  if (m.version) ctx.scan.version = str(m.version);
}

function scanDir(ctx: ScanCtx, dirIn: string, depth: number): void {
  const dir = real(dirIn);
  if (ctx.seenDirs.has(dir) || depth > 3 || !isDir(dir)) return;
  ctx.seenDirs.add(dir);
  const { scan } = ctx;
  const extraSkillDirs: string[] = [];
  const extraCommandDirs: string[] = [];
  const extraAgentDirs: string[] = [];
  const pluginName = dir === ctx.top ? null : basename(dir);
  let mcpFromManifest = false;

  // Claude Code marketplace: a list of plugins, usually in sub-folders of the same repo.
  const market = readJson(join(dir, ".claude-plugin", "marketplace.json"));
  if (market && Array.isArray(market.plugins)) {
    ctx.formats.add("claude-marketplace");
    setIdentity(ctx, dir, { name: market.name, description: market.description ?? (isObj(market.metadata) ? market.metadata.description : ""), version: isObj(market.metadata) ? market.metadata.version : null });
    const base = isObj(market.metadata) && market.metadata.pluginRoot ? resolve(dir, str(market.metadata.pluginRoot)) : dir;
    for (const p of market.plugins as unknown[]) {
      if (!isObj(p)) continue;
      const src = p.source;
      if (typeof src === "string" && !/^[a-z]+:\/\//i.test(src)) {
        const d = resolve(base, src);
        if (d === dir || d.startsWith(dir + sep)) scanDir(ctx, d, depth + 1);
      } else {
        const where = isObj(src) ? str(src.repo ?? src.url ?? src.source) : str(src);
        scan.skipped.push(`${str(p.name) || "A plugin"} lives in another repository (${where}); add it from there.`);
      }
    }
  }

  // Plugin manifests (Claude Code, Codex).
  const claude = readJson(join(dir, ".claude-plugin", "plugin.json"));
  const codex = readJson(join(dir, ".codex-plugin", "plugin.json"));
  const manifest = claude ?? codex;
  if (manifest) {
    ctx.formats.add(claude ? "claude-plugin" : "codex-plugin");
    setIdentity(ctx, dir, manifest);
    extraSkillDirs.push(...asList(manifest.skills));
    extraCommandDirs.push(...asList(manifest.commands));
    extraAgentDirs.push(...asList(manifest.agents));
    if (typeof manifest.mcpServers === "string") {
      readServersFile(ctx, resolve(dir, manifest.mcpServers), dir);
      mcpFromManifest = true;
    } else if (isObj(manifest.mcpServers)) {
      addServers(ctx, manifest.mcpServers, dir, "std");
      mcpFromManifest = true;
    }
  }
  if (manifest?.hooks || isFile(join(dir, "hooks", "hooks.json"))) {
    scan.skipped.push(`${pluginName ?? (str(manifest?.name) || "This plugin")}'s hooks: Cadre doesn't run hooks. Its own approvals still ask before risky actions.`);
  }

  // Gemini CLI extension.
  const gem = readJson(join(dir, "gemini-extension.json"));
  if (gem) {
    ctx.formats.add("gemini-extension");
    setIdentity(ctx, dir, gem);
    if (isObj(gem.mcpServers)) addServers(ctx, gem.mcpServers, dir, "std");
    for (const f of gem.contextFileName ? asList(gem.contextFileName) : ["GEMINI.md"]) addGuide(ctx, resolve(dir, f), dir);
  }

  // OpenCode config (a project's opencode.json, or ~/.config/opencode).
  const oc = readJson(join(dir, "opencode.json")) ?? readJson(join(dir, "opencode.jsonc"));
  if (oc) {
    ctx.formats.add("opencode");
    if (isObj(oc.mcp)) addServers(ctx, oc.mcp, dir, "opencode");
  }
  const ocProject = readJson(join(dir, ".opencode", "opencode.json"));
  if (ocProject && isObj(ocProject.mcp)) addServers(ctx, ocProject.mcp, dir, "opencode");

  // Codex home (~/.codex) or a project's .codex/config.toml.
  for (const f of ["config.toml", join(".codex", "config.toml")]) {
    const t = readToml(join(dir, f));
    if (t && isObj(t.mcp_servers)) {
      if (f === "config.toml") ctx.formats.add("codex-home");
      addServers(ctx, t.mcp_servers, dir, "codex");
    }
  }

  // Gemini home (~/.gemini): its extensions are plugins of their own.
  if (depth === 0 && isDir(join(dir, "extensions"))) {
    for (const e of safeList(join(dir, "extensions"))) {
      const d = join(dir, "extensions", e);
      if (isFile(join(d, "gemini-extension.json"))) scanDir(ctx, d, depth + 1);
    }
  }

  // MCP server files every harness reads.
  if (!mcpFromManifest) readServersFile(ctx, join(dir, ".mcp.json"), dir);
  readServersFile(ctx, join(dir, "mcp.json"), dir);
  readServersFile(ctx, join(dir, ".cursor", "mcp.json"), dir);
  readServersFile(ctx, join(dir, ".vscode", "mcp.json"), dir);
  readServersFile(ctx, join(dir, ".gemini", "settings.json"), dir);
  if (basename(dir) === ".gemini" || isDir(join(dir, "extensions"))) readServersFile(ctx, join(dir, "settings.json"), dir);

  // Skills (Agent Skills: a folder with SKILL.md).
  if (isFile(join(dir, "SKILL.md"))) addSkill(ctx, join(dir, "SKILL.md"), dir);
  for (const d of [...SKILL_DIRS, ...extraSkillDirs]) for (const f of findSkillFiles(resolve(dir, d), 3)) addSkill(ctx, f, dir);
  if (dir === ctx.top) for (const e of safeList(dir)) if (!e.startsWith(".") && isFile(join(dir, e, "SKILL.md"))) addSkill(ctx, join(dir, e, "SKILL.md"), dir);

  // Slash commands / saved prompts: Markdown (Claude, Codex, OpenCode) or TOML (Gemini).
  for (const d of [...COMMAND_DIRS, ...extraCommandDirs]) {
    const base = resolve(dir, d);
    if (!isDir(base)) continue;
    for (const rel of findFiles(base, [".md", ".toml"], 2)) addCommand(ctx, base, rel, dir);
  }

  // Agents → Bot templates.
  for (const d of [...AGENT_DIRS, ...extraAgentDirs]) {
    const base = resolve(dir, d);
    if (!isDir(base)) continue;
    for (const rel of findFiles(base, [".md"], 1)) addAgent(ctx, join(base, rel));
  }

  // Background instructions shipped next to the plugin.
  for (const f of GUIDE_FILES) addGuide(ctx, join(dir, f), dir);
}

function safeList(d: string): string[] {
  try {
    return readdirSync(d).sort();
  } catch {
    return [];
  }
}

function claim(ctx: ScanCtx, file: string): boolean {
  const r = real(file);
  if (ctx.seenFiles.has(r)) return false;
  ctx.seenFiles.add(r);
  return true;
}

function addSkill(ctx: ScanCtx, file: string, root: string) {
  if (!claim(ctx, file)) return;
  const text = readText(file);
  if (text == null) return;
  const { data, body } = splitFrontmatter(text);
  const dir = dirname(file);
  ctx.scan.skills.push({
    name: slugify(str(data.name) || basename(dir)),
    description: clip(str(data.description) || firstLine(body) || `Skill from ${basename(dir)}`, 300),
    kind: "skill",
    file,
    dir,
    root,
  });
}

function addCommand(ctx: ScanCtx, base: string, rel: string, root: string) {
  const file = join(base, rel);
  if (!claim(ctx, file)) return;
  const name = slugify(rel.replace(/\.(md|toml)$/i, "").split(sep).join("-"));
  if (rel.toLowerCase().endsWith(".toml")) {
    const t = readToml(file);
    const prompt = str(t?.prompt);
    if (!prompt) return;
    ctx.scan.skills.push({ name, description: clip(str(t?.description) || firstLine(prompt) || `Command ${name}`, 300), kind: "command", file, dir: dirname(file), root, prompt });
    return;
  }
  const text = readText(file);
  if (text == null) return;
  const { data, body } = splitFrontmatter(text);
  if (!body.trim()) return;
  ctx.scan.skills.push({ name, description: clip(str(data.description) || firstLine(body) || `Command ${name}`, 300), kind: "command", file, dir: dirname(file), root });
}

function addAgent(ctx: ScanCtx, file: string) {
  if (!claim(ctx, file)) return;
  const text = readText(file);
  if (text == null) return;
  const { data, body } = splitFrontmatter(text);
  if (!body.trim()) return;
  const skills = Array.isArray(data.skills) ? data.skills.map(str) : str(data.skills).split(",").map((s) => s.trim()).filter(Boolean);
  ctx.scan.agents.push({
    name: str(data.name) || basename(file, ".md"),
    description: clip(str(data.description) || firstLine(body), 300),
    brief: body.trim(),
    file,
    skills,
  });
}

function addGuide(ctx: ScanCtx, file: string, root: string) {
  if (!isFile(file) || !claim(ctx, file)) return;
  const text = readText(file);
  if (!text?.trim()) return;
  const owner = root === ctx.top ? ctx.scan.name : basename(root);
  ctx.scan.skills.push({
    name: slugify(`${owner}-${basename(file, ".md")}`),
    description: clip(`Background, rules and conventions for ${owner} (its ${basename(file)}). Read it before using ${owner}'s other skills or apps.`, 300),
    kind: "guide",
    file,
    dir: dirname(file),
    root,
  });
}

function readServersFile(ctx: ScanCtx, file: string, root: string) {
  if (!isFile(file) || !claim(ctx, file)) return;
  const j = readJson(file);
  if (!j) return;
  if (isObj(j.mcpServers)) addServers(ctx, j.mcpServers, root, "std");
  else if (isObj(j.servers)) addServers(ctx, j.servers, root, "std");
  else if (basename(file) === ".mcp.json") addServers(ctx, j, root, "std"); // plugin .mcp.json may skip the wrapper
}

function addServers(ctx: ScanCtx, map: Json, root: string, flavor: "std" | "opencode" | "codex") {
  for (const [key, raw] of Object.entries(map)) {
    if (!isObj(raw) || ctx.scan.servers.some((s) => s.key === key)) continue;
    const notes: string[] = [];
    const off = raw.disabled === true || raw.enabled === false;
    let transport: "http" | "stdio" = "stdio";
    let url: string | null = null;
    let command: string | null = null;
    let args: string[] = [];
    let env: Record<string, string> = {};
    let headers: Record<string, string> = {};
    const strMap = (v: unknown): Record<string, string> => (isObj(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, str(x)])) : {});

    if (flavor === "opencode") {
      if (raw.type === "remote") {
        transport = "http";
        url = str(raw.url) || null;
        headers = strMap(raw.headers);
      } else {
        const cmd = Array.isArray(raw.command) ? raw.command.map(str) : [str(raw.command)];
        command = cmd[0] || null;
        args = cmd.slice(1);
        env = strMap(raw.environment);
      }
    } else if (flavor === "codex") {
      if (raw.url) {
        transport = "http";
        url = str(raw.url);
        headers = strMap(raw.http_headers);
        if (raw.bearer_token_env_var) headers.Authorization = `Bearer \${${str(raw.bearer_token_env_var)}}`;
        for (const [h, v] of Object.entries(strMap(raw.env_http_headers))) headers[h] = `\${${v}}`;
      } else {
        command = str(raw.command) || null;
        args = Array.isArray(raw.args) ? raw.args.map(str) : [];
        env = strMap(raw.env);
      }
    } else {
      const u = raw.url ?? raw.httpUrl ?? raw.serverUrl;
      if (u || ["http", "sse", "streamable-http", "streamableHttp"].includes(str(raw.type))) {
        transport = "http";
        url = str(u) || null;
        headers = strMap(raw.headers);
      } else {
        command = str(raw.command) || null;
        args = Array.isArray(raw.args) ? raw.args.map(str) : [];
        env = strMap(raw.env);
        if (raw.cwd) notes.push(`It asked to run in ${str(raw.cwd)}; Cadre runs it from its own folder.`);
      }
    }
    if (transport === "http" && !url) continue;
    if (transport === "stdio" && !command) continue;
    let auth: string | null = null;
    for (const [h, v] of Object.entries(headers)) {
      if (h.toLowerCase() === "authorization") auth = v;
      else notes.push(`Cadre only sends the Authorization header, so its ${h} header isn't sent.`);
    }
    ctx.scan.servers.push({ key, transport, url, command, args, env, auth, root, off, notes });
  }
}

// ---------- the manager ----------

const AGENT_COLORS = AVATAR_COLORS as readonly string[];

function hashIndex(s: string, n: number): number {
  return createHash("sha1").update(s).digest().readUInt32BE(0) % n;
}

const titleCase = (s: string) =>
  s
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b([a-z])/g, (m) => m.toUpperCase())
    .replace(/\b(Sre|Aws|Api|Eks|Ssm|Vpc|Ssh|Qa|Ui|Ux|Ci|Cd|Pr|Db|Sql|Llm|Ai)\b/g, (m) => m.toUpperCase());

/** "https://github.com/o/r", "github.com/o/r", "o/r", git@…, …/tree/<branch>/<sub> → what to clone. */
export function parseGitSource(source: string): { url: string; branch: string | null; sub: string } | null {
  const s = source.trim();
  const tree = /^(?:https?:\/\/)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/tree\/([^/]+)\/?(.*)$/.exec(s);
  if (tree) return { url: `https://github.com/${tree[1]}/${tree[2]}.git`, branch: tree[3]!, sub: tree[4] ?? "" };
  if (/^(https?:\/\/|ssh:\/\/|git@|file:\/\/)/.test(s)) return { url: s, branch: null, sub: "" };
  const gh = /^(?:github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(s);
  if (gh && (s.startsWith("github.com/") || !s.startsWith("."))) return { url: `https://github.com/${gh[1]}/${gh[2]}.git`, branch: null, sub: "" };
  return null;
}

const expandHome = (p: string) => (p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

interface Resolved {
  sourceKind: "folder" | "git";
  path: string;
  url: string | null;
  /** For git: the clone folder to move into place on install. */
  cloneDir?: string;
}

export interface PluginSkillEntry extends ScannedSkill {
  pluginId: string;
  plugin: string;
}

export class PluginManager {
  private cache = new Map<string, { at: number; scan: PluginScan | null; error: string | null }>();
  private agentTemplateCache: BotTemplate[] | null = null;

  constructor(
    private store: Store,
    private connectors: ConnectorManager,
    private emit: (e: ServerEvent) => void,
    /** Where git plugins are cloned and plugins keep their data. */
    private dir: string,
    private workspaceDir: string,
  ) {}

  // ----- reading -----

  private scanOf(p: PluginRow, fresh = false): { scan: PluginScan | null; error: string | null } {
    const hit = this.cache.get(p.id);
    if (hit && !fresh && Date.now() - hit.at < 10_000) return hit;
    let entry: { at: number; scan: PluginScan | null; error: string | null };
    try {
      entry = { at: Date.now(), scan: scanPluginFolder(p.path), error: null };
    } catch (err) {
      entry = { at: Date.now(), scan: null, error: (err as Error).message };
    }
    this.cache.set(p.id, entry);
    this.agentTemplateCache = null;
    return entry;
  }

  private describeServers(scan: PluginScan, owned: Record<string, string>): PluginServerInfo[] {
    const rows = this.store.connectors.list();
    return scan.servers.map((s) => {
      const id = owned[s.key];
      const row = (id && rows.find((r) => r.id === id)) || this.findExisting(s, rows);
      return {
        key: s.key,
        transport: s.transport,
        url: s.url,
        command: s.command ? [s.command, ...s.args].join(" ").slice(0, 200) : null,
        needs: serverNeeds(s),
        off: s.off,
        notes: s.notes,
        connectorId: row ? row.id : null,
        connectorName: row ? row.name : null,
      };
    });
  }

  /** A connector already in Connect apps for the same server (same URL, or same command line). */
  private findExisting(s: ScannedServer, rows = this.store.connectors.list()) {
    const sub = (v: string) => this.fill(v, s, {});
    if (s.transport === "http") {
      const url = sub(s.url ?? "").replace(/\/+$/, "");
      return rows.find((r) => r.transport === "http" && (r.url ?? "").replace(/\/+$/, "") === url);
    }
    const line = JSON.stringify([sub(s.command ?? ""), ...s.args.map(sub)]);
    return rows.find((r) => r.transport === "stdio" && JSON.stringify([r.command, ...r.args]) === line);
  }

  private contents(scan: PluginScan, owned: Record<string, string>, pluginId: string | null): PluginContents {
    const names = pluginId ? new Map(this.skillEntries().filter((e) => e.pluginId === pluginId).map((e) => [e.file + (e.prompt ? "#" : ""), e.name])) : null;
    return {
      name: scan.name,
      description: scan.description,
      version: scan.version,
      formats: scan.formats,
      skills: scan.skills.map((s) => ({ name: names?.get(s.file + (s.prompt ? "#" : "")) ?? s.name, description: s.description, kind: s.kind, path: s.file })),
      agents: scan.agents.map((a) => ({ name: a.name, description: a.description, templateId: pluginId ? this.templateId(pluginId, a.name) : "" })),
      servers: this.describeServers(scan, owned),
      skipped: scan.skipped,
    };
  }

  list(): InstalledPlugin[] {
    return this.store.plugins.list().map((p) => this.describe(p));
  }

  describe(p: PluginRow, fresh = false): InstalledPlugin {
    const { scan, error } = this.scanOf(p, fresh);
    const empty: PluginContents = { name: p.name, description: "", version: null, formats: [], skills: [], agents: [], servers: [], skipped: [] };
    return {
      ...(scan ? this.contents(scan, p.servers, p.id) : empty),
      name: p.name,
      id: p.id,
      sourceKind: p.sourceKind,
      path: p.path,
      url: p.url,
      enabled: p.enabled,
      error,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    };
  }

  /** Every enabled plugin's skills, named so no two skills (saved or plugin) share a name. */
  skillEntries(): PluginSkillEntry[] {
    const taken = new Set(this.store.skills.list().map((s) => s.name));
    const out: PluginSkillEntry[] = [];
    for (const p of this.store.plugins.list()) {
      if (!p.enabled) continue;
      const { scan } = this.scanOf(p);
      if (!scan) continue;
      for (const s of scan.skills) {
        let name = s.name;
        if (taken.has(name)) name = slugify(`${p.name}-${s.name}`);
        for (let i = 2; taken.has(name); i++) name = `${slugify(`${p.name}-${s.name}`, 56)}-${i}`;
        taken.add(name);
        out.push({ ...s, name, pluginId: p.id, plugin: p.name });
      }
    }
    return out;
  }

  /** Plugin skills in the shape the Skills list and composer use (content loads on demand). */
  skillList(): Skill[] {
    return this.skillEntries().map((e) => ({
      id: `plugin:${e.pluginId}:${e.name}`,
      name: e.name,
      description: e.description,
      content: "",
      source: "plugin",
      plugin: e.plugin,
      createdAt: "",
      updatedAt: "",
    }));
  }

  /** A plugin skill's instructions with its folder spelled out, so the Bot can open its files and scripts. */
  readSkill(name: string): string | null {
    const e = this.skillEntries().find((s) => s.name === name);
    if (!e) return null;
    let body = e.prompt ?? readText(e.file, 2_000_000) ?? "";
    body = splitFrontmatter(body).body.trim();
    body = body
      .replaceAll("${CLAUDE_PLUGIN_ROOT}", e.root)
      .replaceAll("${CLAUDE_SKILL_DIR}", e.dir)
      .replaceAll("${extensionPath}", e.root)
      .replaceAll("{baseDir}", e.dir);
    if (body.length > 60_000) body = `${body.slice(0, 60_000)}\n\n[…cut at 60,000 characters; the full file is ${e.file}]`;
    const lines: string[] = [`# ${e.name}`, e.description, `(from the ${e.plugin} plugin)`, "", body, ""];
    if (e.kind === "command") {
      lines.push("This is a slash command: $ARGUMENTS (or {{args}}) stands for what the user asked for with it.");
    } else if (e.kind === "skill") {
      const files = listFolder(e.dir);
      lines.push(
        `Files: this skill's folder is ${e.dir}${e.root !== e.dir ? ` (inside the plugin at ${e.root})` : ""}. Relative paths above are relative to that folder. Read its files and run its scripts from there with your shell.`,
      );
      if (files.length) lines.push(`Its files: ${files.join(", ")}`);
    } else {
      lines.push(`File: ${e.file}. The plugin's folder is ${e.root}.`);
    }
    return lines.join("\n");
  }

  private templateId(pluginId: string, agent: string): string {
    return `plugin-${pluginId.slice(0, 8)}-${slugify(agent, 40)}`;
  }

  /** Every enabled plugin's agents as Bot templates (hire them like any other). */
  agentTemplates(): BotTemplate[] {
    if (this.agentTemplateCache) return this.agentTemplateCache;
    const out: BotTemplate[] = [];
    for (const p of this.store.plugins.list()) {
      if (!p.enabled) continue;
      const { scan } = this.scanOf(p);
      for (const a of scan?.agents ?? []) {
        const id = this.templateId(p.id, a.name);
        const brief = [
          a.brief,
          a.skills.length ? `\nSkills to use (call skill_read first): ${a.skills.join(", ")}.` : "",
          `\n(Hired from the ${p.name} plugin's ${a.name} agent.)`,
        ].join("");
        out.push({
          id,
          name: titleCase(a.name),
          label: titleCase(a.name),
          category: "plugins",
          emoji: "🧩",
          color: AGENT_COLORS[hashIndex(id, AGENT_COLORS.length)] ?? "#7c5cff",
          shape: AVATAR_SHAPES[hashIndex(`${id}#`, AVATAR_SHAPES.length)] as AvatarShape,
          tagline: clip(a.description || `${a.name} from ${p.name}`, 160),
          brief,
          memory: [],
          routines: [],
          skills: [],
          rules: [],
          asks: [],
        });
      }
    }
    this.agentTemplateCache = out;
    return out;
  }

  // ----- adding -----

  private async resolveSource(source: string, forInstall: boolean): Promise<Resolved> {
    const local = resolve(expandHome(source.trim()));
    if (existsSync(local)) return { sourceKind: "folder", path: real(local), url: null };
    const git = parseGitSource(source);
    if (!git) throw new Error(`No folder at ${source}, and it isn't a git URL.`);
    const cloneDir = join(this.dir, `.preview-${createHash("sha1").update(`${git.url}#${git.branch ?? ""}`).digest("hex").slice(0, 12)}`);
    if (!forInstall || !isDir(cloneDir)) {
      rmSync(cloneDir, { recursive: true, force: true });
      mkdirSync(this.dir, { recursive: true });
      try {
        await run("git", ["clone", "--depth", "1", ...(git.branch ? ["--branch", git.branch] : []), "--", git.url, cloneDir], {
          timeout: 180_000,
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        });
      } catch (err) {
        rmSync(cloneDir, { recursive: true, force: true });
        const msg = String((err as { stderr?: string }).stderr || (err as Error).message).trim().split("\n").slice(-2).join(" ");
        throw new Error(`Couldn't download ${git.url}: ${msg}`);
      }
    }
    const path = git.sub ? join(cloneDir, git.sub) : cloneDir;
    if (!isDir(path)) throw new Error(`The repository has no folder ${git.sub}.`);
    return { sourceKind: "git", path, url: source.trim(), cloneDir };
  }

  private installedFor(r: Resolved): PluginRow | undefined {
    return this.store.plugins.list().find((p) => (r.url ? p.url === r.url : p.path === r.path));
  }

  async preview(source: string): Promise<PluginPreview> {
    const r = await this.resolveSource(source, false);
    const scan = scanPluginFolder(r.path);
    const installed = this.installedFor(r);
    const contents = this.contents(scan, installed?.servers ?? {}, null);
    if (!contents.skills.length && !contents.agents.length && !contents.servers.length) {
      throw new Error("Found no skills, commands, agents or MCP servers there. Pick a plugin folder, a skills folder or a harness folder like ~/.claude.");
    }
    return { ...contents, path: r.path, sourceKind: r.sourceKind, url: r.url, installedId: installed?.id ?? null };
  }

  async install(input: { source: string; secrets: Record<string, string>; servers?: string[] }): Promise<InstalledPlugin> {
    const r = await this.resolveSource(input.source, true);
    if (this.installedFor(r)) throw new Error("That plugin is already installed. Use Refresh or Update on it.");
    let path = r.path;
    if (r.sourceKind === "git" && r.cloneDir) {
      const scanName = scanPluginFolder(r.path).name;
      const dest = join(this.dir, `${slugify(scanName, 40)}-${createHash("sha1").update(r.url ?? "").digest("hex").slice(0, 6)}`);
      rmSync(dest, { recursive: true, force: true });
      renameSync(r.cloneDir, dest);
      path = join(dest, relative(r.cloneDir, r.path));
    }
    const scan = scanPluginFolder(path);
    const row = this.store.plugins.create({ name: scan.name, sourceKind: r.sourceKind, path, url: r.url, servers: {} });
    const owned = this.addServers(row.id, scan, input.secrets, input.servers);
    this.store.plugins.update(row.id, { servers: owned });
    this.changed(row.id);
    return this.describe(this.store.plugins.get(row.id)!, true);
  }

  /** Fills ${VAR} placeholders: the user's values, then Cadre's own (plugin folder…), then the environment. */
  private fill(v: string, s: ScannedServer, secrets: Record<string, string>, pluginId?: string): string {
    return substitute(v, (name, def) => {
      if (name === "CLAUDE_PLUGIN_ROOT" || name === "extensionPath") return s.root;
      if (name === "CLAUDE_PLUGIN_DATA") {
        const d = join(this.dir, "data", pluginId ?? "preview");
        mkdirSync(d, { recursive: true });
        return d;
      }
      if (name === "workspaceFolder") return this.workspaceDir;
      if (name === "HOME") return homedir();
      const given = secrets[name]?.trim();
      if (given) return given;
      return process.env[name] ?? def ?? "";
    });
  }

  /** Adds the plugin's MCP servers to Connect apps; returns serverKey → connector id for the ones it created. */
  private addServers(pluginId: string, scan: PluginScan, secrets: Record<string, string>, pick?: string[]): Record<string, string> {
    const owned: Record<string, string> = {};
    for (const s of scan.servers) {
      if (pick ? !pick.includes(s.key) : s.off) continue;
      if (this.findExisting(s)) continue; // already in Connect apps: share it
      const name = this.connectorName(scan.name, s.key);
      const label = `${titleCase(s.key)} · ${scan.name}`.slice(0, 80);
      const sub = (v: string) => this.fill(v, s, secrets, pluginId);
      let auth = s.auth ? sub(s.auth).trim() : "";
      if (/^(Bearer|Basic|Token)\s*(token=)?$/i.test(auth)) auth = ""; // the token variable was left empty
      const row =
        s.transport === "http"
          ? this.store.connectors.create({ name, label, transport: "http", url: sub(s.url ?? ""), args: [], env: {}, bearerToken: auth || undefined, enabled: true })
          : this.store.connectors.create({
              name,
              label,
              transport: "stdio",
              command: sub(s.command ?? ""),
              args: s.args.map(sub),
              env: Object.fromEntries(Object.entries(s.env).map(([k, v]) => [k, sub(v)])),
              enabled: true,
            });
      owned[s.key] = row.id;
      void this.connectors.connect(row.id).catch(() => undefined);
    }
    return owned;
  }

  private connectorName(plugin: string, key: string): string {
    const taken = new Set(this.store.connectors.list().map((c) => c.name));
    const clean = (v: string) => v.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[^a-z0-9]+/, "").slice(0, 40).replace(/-+$/, "");
    const first = clean(key);
    if (first.length >= 2 && !taken.has(first)) return first;
    const base = clean(`${plugin}-${key}`).slice(0, 36) || "plugin-app";
    if (!taken.has(base)) return base;
    for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
  }

  /** Re-reads the folder; adds apps the plugin gained since (with no secrets: they connect or ask to sign in). */
  refresh(id: string): InstalledPlugin | null {
    const p = this.store.plugins.get(id);
    if (!p) return null;
    const { scan } = this.scanOf(p, true);
    if (scan) {
      const owned = { ...p.servers };
      const fresh = scan.servers.filter((s) => !owned[s.key] && !s.off && !this.findExisting(s));
      if (fresh.length) {
        Object.assign(owned, this.addServers(p.id, { ...scan, servers: fresh }, {}));
        this.store.plugins.update(p.id, { servers: owned, name: scan.name });
      } else if (scan.name !== p.name) this.store.plugins.update(p.id, { name: scan.name });
    }
    this.changed(id);
    return this.describe(this.store.plugins.get(id)!, true);
  }

  /** git plugins: pull the latest commit, then refresh. */
  async update(id: string): Promise<InstalledPlugin | null> {
    const p = this.store.plugins.get(id);
    if (!p) return null;
    if (p.sourceKind !== "git") return this.refresh(id);
    try {
      const { stdout } = await run("git", ["-C", p.path, "rev-parse", "--show-toplevel"], { timeout: 10_000 });
      // Cadre's own shallow clone: fetch the branch's newest commit and move to it (never your folder).
      const top = stdout.trim();
      const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
      const branch = (await run("git", ["-C", top, "rev-parse", "--abbrev-ref", "HEAD"], { timeout: 10_000 })).stdout.trim();
      await run("git", ["-C", top, "fetch", "--depth", "1", "origin", branch === "HEAD" ? "HEAD" : branch], { timeout: 180_000, env });
      await run("git", ["-C", top, "reset", "--hard", "FETCH_HEAD"], { timeout: 30_000, env });
    } catch (err) {
      const msg = String((err as { stderr?: string }).stderr || (err as Error).message).trim().split("\n").slice(-2).join(" ");
      throw new Error(`Couldn't update: ${msg}`);
    }
    return this.refresh(id);
  }

  async setEnabled(id: string, enabled: boolean): Promise<InstalledPlugin | null> {
    const p = this.store.plugins.update(id, { enabled });
    if (!p) return null;
    for (const cid of Object.values(p.servers)) {
      if (!this.store.connectors.get(cid)) continue;
      this.store.connectors.update(cid, { enabled });
      void this.connectors.connect(cid).catch(() => undefined);
    }
    this.changed(id);
    return this.describe(p);
  }

  /** Removes the plugin, its apps (unless `keepApps`) and Cadre's clone of it (never your own folder). */
  async remove(id: string, keepApps = false): Promise<boolean> {
    const p = this.store.plugins.get(id);
    if (!p) return false;
    if (!keepApps) {
      for (const cid of Object.values(p.servers)) {
        if (!this.store.connectors.get(cid)) continue;
        await this.connectors.disconnect(cid);
        this.store.connectors.delete(cid);
        this.emit({ type: "connector.deleted", connectorId: cid });
      }
    }
    this.store.plugins.delete(id);
    if (p.sourceKind === "git") {
      const top = join(this.dir, relative(this.dir, p.path).split(sep)[0] ?? "");
      if (top !== this.dir && top.startsWith(this.dir + sep)) rmSync(top, { recursive: true, force: true });
    }
    rmSync(join(this.dir, "data", id), { recursive: true, force: true });
    this.changed(id);
    return true;
  }

  private changed(id: string) {
    this.cache.delete(id);
    this.agentTemplateCache = null;
    this.emit({ type: "plugins.updated" });
  }

  /** Plugin and skills folders other harnesses keep on this computer. */
  suggestions(): PluginSuggestion[] {
    const home = homedir();
    const out: PluginSuggestion[] = [];
    const installed = this.store.plugins.list();
    const add = (label: string, harness: string, path: string) => {
      if (!isDir(path) || out.some((o) => o.path === path)) return;
      const r = real(path);
      out.push({ label, harness, path, installedId: installed.find((p) => p.path === r || p.path === path)?.id ?? null });
    };
    const claudeInstalled = readJson(join(home, ".claude", "plugins", "installed_plugins.json"));
    if (claudeInstalled && isObj(claudeInstalled.plugins)) {
      for (const [key, entries] of Object.entries(claudeInstalled.plugins)) {
        const list = Array.isArray(entries) ? entries.filter(isObj) : [];
        const last = list[list.length - 1];
        const p = last ? str(last.installPath) : "";
        if (p) add(key.split("@")[0] ?? key, "Claude Code plugin", p);
      }
    }
    add("Your Claude Code skills, commands and agents", "Claude Code", join(home, ".claude"));
    add("Your Codex skills, prompts and MCP servers", "Codex", join(home, ".codex"));
    add("Your Gemini CLI extensions, commands and MCP servers", "Gemini CLI", join(home, ".gemini"));
    add("Your OpenCode skills, commands, agents and MCP servers", "OpenCode", join(home, ".config", "opencode"));
    add("Your shared agent skills", "Agent Skills", join(home, ".agents", "skills"));
    add("Your Cursor MCP servers", "Cursor", join(home, ".cursor"));
    return out;
  }
}
