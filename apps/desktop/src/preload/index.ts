import { contextBridge, ipcRenderer } from "electron";

const serverUrl =
  process.argv.find((a) => a.startsWith("--cadre-server-url="))?.split("=").slice(1).join("=") ??
  "http://localhost:3123";

contextBridge.exposeInMainWorld("cadre", {
  serverUrl,
  platform: process.platform,
  notify: (n: { title: string; body: string; botId?: string; conversationId?: string }) => ipcRenderer.send("cadre:notify", n),
  setBadge: (count: number) => ipcRenderer.send("cadre:badge", count),
  isFocused: (): Promise<boolean> => ipcRenderer.invoke("cadre:isFocused"),
  getZoom: (): Promise<number> => ipcRenderer.invoke("cadre:getZoom"),
  setZoom: (factor: number) => ipcRenderer.send("cadre:setZoom", factor),
  copyText: (text: string) => ipcRenderer.send("cadre:copy", text),
  pickFolder: (title?: string): Promise<string | null> => ipcRenderer.invoke("cadre:pickFolder", title),
});

// ⌘= / ⌘- / ⌘0 and the Settings slider all report the new zoom back to the page.
ipcRenderer.on("cadre:zoom", (_e, factor: number) => {
  window.dispatchEvent(new CustomEvent("cadre:zoom", { detail: factor }));
});

// Clicking a notification asks the renderer to open that conversation.
ipcRenderer.on("cadre:open", (_e, detail: { botId?: string; conversationId?: string }) => {
  window.dispatchEvent(new CustomEvent("cadre:open", { detail }));
});
