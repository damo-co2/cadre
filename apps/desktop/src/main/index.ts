import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, Notification, shell, type MenuItemConstructorOptions } from "electron";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const PORT = Number(process.env.CADRE_PORT ?? 3123);
const SERVER_URL = process.env.CADRE_SERVER_URL ?? `http://localhost:${PORT}`;

let server: ChildProcess | null = null;

/**
 * Apps launched from Finder get a minimal PATH, so the model CLIs (claude, codex, gemini) and
 * Homebrew tools would be invisible to Bots. Borrow the user's login-shell PATH instead.
 */
function adoptShellPath(): void {
  if (process.platform === "win32") return;
  try {
    const shell = process.env.SHELL || "/bin/zsh";
    const out = execFileSync(shell, ["-ilc", 'printf "%s" "$PATH"'], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
    if (out.includes("/")) process.env.PATH = out.trim();
  } catch {
    /* keep the inherited PATH */
  }
}

/** Repo root in dev (apps/desktop/../..), resources dir when packaged. */
function repoRoot(): string {
  return app.isPackaged ? process.resourcesPath : resolve(app.getAppPath(), "..", "..");
}

async function serverIsUp(): Promise<boolean> {
  try {
    const r = await fetch(`${SERVER_URL}/api/health`, { signal: AbortSignal.timeout(800) });
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * The desktop app owns the local server: start it if nothing is listening yet (a developer
 * running `npm run dev:server` separately keeps theirs). Data lives in the OS user-data dir.
 */
async function ensureServer(): Promise<void> {
  if (process.env.CADRE_SERVER_URL || (await serverIsUp())) return;
  const root = repoRoot();
  const dataDir = join(app.getPath("userData"), "data");
  // The sandbox: the one folder Bots may change freely. Visible in Finder as ~/Cadre.
  const workspaceDir = process.env.WORKSPACE_DIR ?? join(app.getPath("home"), "Cadre");
  const env = { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, WORKSPACE_DIR: workspaceDir, ELECTRON_RUN_AS_NODE: "1" };
  const bundle = join(root, "server", "index.cjs");
  const dist = join(root, "apps", "server", "dist", "index.js");
  if (app.isPackaged && existsSync(bundle)) {
    server = spawn(process.execPath, [bundle], { cwd: join(root, "server"), env: { ...env, NODE_PATH: join(root, "server", "deps"), RENDERER_DIR: join(root, "renderer") }, stdio: "inherit" });
  } else if (existsSync(dist)) {
    server = spawn(process.execPath, [dist], { cwd: root, env, stdio: "inherit" });
  } else {
    const tsx = join(root, "node_modules", "tsx", "dist", "cli.mjs");
    server = spawn(process.execPath, [tsx, join(root, "apps", "server", "src", "index.ts")], { cwd: root, env, stdio: "inherit" });
  }
  server.on("exit", (code) => {
    console.log(`[cadre] server exited with ${code}`);
    server = null;
  });
  for (let i = 0; i < 60; i++) {
    if (await serverIsUp()) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  console.warn("[cadre] server did not come up in time; the window will keep retrying");
}

// ---- zoom: ⌘= / ⌘- / ⌘0, trackpad pinch, remembered across launches ----
// "100%" in Cadre is Chromium's 125%: the UI reads comfortably at that size on a laptop screen.
// Everything user-facing (menu, Settings, the zoom.json file) speaks in these display levels.
const ZOOM_BASE = 1.25;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2;
const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
const zoomFile = () => join(app.getPath("userData"), "zoom.json");
function savedZoom(): number {
  try {
    // Files from before the 125% baseline stored a raw `factor`; those start fresh at the new 100%.
    const z = Number(JSON.parse(readFileSync(zoomFile(), "utf8")).display);
    return z >= ZOOM_MIN && z <= ZOOM_MAX ? z : 1;
  } catch {
    return 1;
  }
}
const displayOf = (win: BrowserWindow) => Math.round((win.webContents.getZoomFactor() / ZOOM_BASE) * 100) / 100;
function setZoom(win: BrowserWindow | null | undefined, display: number) {
  if (!win) return;
  const d = Math.round(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, display)) * 100) / 100;
  win.webContents.setZoomFactor(d * ZOOM_BASE);
  try {
    writeFileSync(zoomFile(), JSON.stringify({ display: d }));
  } catch {
    /* not fatal */
  }
  win.webContents.send("cadre:zoom", d);
}
const focused = () => BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
function stepZoom(dir: 1 | -1) {
  const win = focused();
  if (!win) return;
  const cur = displayOf(win);
  const next = dir > 0 ? (ZOOM_STEPS.find((z) => z > cur + 0.001) ?? ZOOM_MAX) : ([...ZOOM_STEPS].reverse().find((z) => z < cur - 0.001) ?? ZOOM_MIN);
  setZoom(win, next);
}

function buildMenu() {
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === "darwin" ? [{ role: "appMenu" as const }] : []),
    { role: "fileMenu" },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { label: "Actual Size", accelerator: "CmdOrCtrl+0", click: () => setZoom(focused(), 1) },
        { label: "Zoom In", accelerator: "CmdOrCtrl+=", click: () => stepZoom(1) },
        { label: "Zoom In ", accelerator: "CmdOrCtrl+Plus", visible: false, click: () => stepZoom(1) },
        { label: "Zoom Out", accelerator: "CmdOrCtrl+-", click: () => stepZoom(-1) },
        { type: "separator" },
        { role: "togglefullscreen" },
        { type: "separator" },
        { role: "reload" },
        { role: "toggleDevTools" },
      ],
    },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    show: false,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    trafficLightPosition: { x: 14, y: 14 },
    backgroundColor: "#0e0e11",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: true,
      contextIsolation: true,
      additionalArguments: [`--cadre-server-url=${SERVER_URL}`],
    },
  });
  win.on("ready-to-show", () => win.show());
  win.webContents.on("did-finish-load", () => {
    win.webContents.setZoomFactor(savedZoom() * ZOOM_BASE);
    // Trackpad pinch-to-zoom.
    void win.webContents.setVisualZoomLevelLimits(1, 3);
  });
  // Never let a link replace the app in its own window: open it in the browser instead.
  // File downloads (download=1, served as attachments) are allowed through and become downloads.
  win.webContents.on("will-navigate", (e, url) => {
    const current = win.webContents.getURL();
    if (url === current || url.includes("download=1")) return;
    if (process.env.ELECTRON_RENDERER_URL && url.startsWith(process.env.ELECTRON_RENDERER_URL)) return;
    e.preventDefault();
    if (/^https?:/i.test(url)) void shell.openExternal(url);
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void win.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

// ---- notifications, badge, focus (asked for by the renderer through the preload bridge) ----
ipcMain.on("cadre:notify", (_e, n: { title: string; body: string; botId?: string; conversationId?: string }) => {
  if (!Notification.isSupported()) return;
  const note = new Notification({ title: n.title, body: n.body, silent: false });
  note.on("click", () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return createWindow();
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    win.webContents.send("cadre:open", { botId: n.botId, conversationId: n.conversationId });
  });
  note.show();
});
ipcMain.on("cadre:badge", (_e, count: number) => {
  if (process.platform === "darwin") app.dock?.setBadge(count > 0 ? String(count) : "");
  else app.setBadgeCount(Math.max(0, count | 0));
});
ipcMain.handle("cadre:getZoom", (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  return win ? displayOf(win) : 1;
});
ipcMain.on("cadre:setZoom", (e, factor: number) => setZoom(BrowserWindow.fromWebContents(e.sender), Number(factor) || 1));
ipcMain.on("cadre:copy", (_e, text: string) => clipboard.writeText(String(text ?? "")));
ipcMain.handle("cadre:isFocused", () => BrowserWindow.getAllWindows().some((w) => w.isFocused()));
ipcMain.handle("cadre:pickFolder", async (e, title?: string) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const opts: Electron.OpenDialogOptions = { title: typeof title === "string" ? title : "Choose a folder", properties: ["openDirectory", "showHiddenFiles"] };
  const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  return res.canceled ? null : (res.filePaths[0] ?? null);
});

app.whenReady().then(async () => {
  if (app.isPackaged) adoptShellPath();
  buildMenu();
  await ensureServer();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  server?.kill("SIGTERM");
});
