import { spawn, type ChildProcess } from "node:child_process";
import type { ServerEvent } from "@grokbot/shared";

/** After the last Bot finishes, stay awake this long so back-to-back turns don't flip it on and off. */
const RELEASE_AFTER_MS = 60_000;

/**
 * Keeps the computer from going to sleep while any Bot is working (or waiting on an approval).
 * The screen can still turn off and lock; only system sleep is held off. Closing a laptop's lid
 * on battery still sleeps it: the OS doesn't let apps block that.
 *
 * It runs the OS's own tool as a child process (macOS caffeinate, Linux systemd-inhibit, Windows
 * SetThreadExecutionState): killing it lets the computer sleep again, and on macOS it also exits
 * by itself if the server dies.
 */
export class KeepAwake {
  private busy = new Set<string>();
  private proc: ChildProcess | null = null;
  private releaseTimer: NodeJS.Timeout | null = null;

  constructor(
    private spawnHolder: () => ChildProcess | null = holdAwake,
    private releaseAfterMs = RELEASE_AFTER_MS,
  ) {}

  /** Feed it every server event; it only looks at Bot status changes. */
  onEvent(e: ServerEvent): void {
    if (e.type !== "bot.status") return;
    if (e.status === "idle") this.busy.delete(e.botId);
    else this.busy.add(e.botId);
    if (this.busy.size) this.hold();
    else this.scheduleRelease();
  }

  get holding(): boolean {
    return this.proc !== null;
  }

  stop(): void {
    if (this.releaseTimer) clearTimeout(this.releaseTimer);
    this.releaseTimer = null;
    this.proc?.kill();
    this.proc = null;
  }

  private hold(): void {
    if (this.releaseTimer) clearTimeout(this.releaseTimer);
    this.releaseTimer = null;
    if (this.proc) return;
    const p = this.spawnHolder();
    if (!p) return;
    this.proc = p;
    p.on("exit", () => {
      if (this.proc === p) this.proc = null;
    });
    p.on("error", () => {
      if (this.proc === p) this.proc = null;
    });
  }

  private scheduleRelease(): void {
    if (!this.proc || this.releaseTimer) return;
    this.releaseTimer = setTimeout(() => {
      this.releaseTimer = null;
      if (!this.busy.size) this.stop();
    }, this.releaseAfterMs);
    this.releaseTimer.unref?.();
  }
}

function holdAwake(): ChildProcess | null {
  const opts = { stdio: "ignore" as const };
  try {
    if (process.platform === "darwin") return spawn("caffeinate", ["-i", "-w", String(process.pid)], opts);
    if (process.platform === "linux")
      return spawn("systemd-inhibit", ["--what=idle:sleep", "--who=Cadre", "--why=Bots are working", "--mode=block", "sleep", "infinity"], opts);
    if (process.platform === "win32") {
      // ES_CONTINUOUS | ES_SYSTEM_REQUIRED, held for as long as this PowerShell lives.
      const ps =
        "$s=Add-Type -PassThru -Name P -Namespace W -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint f);';" +
        "[void]$s::SetThreadExecutionState([uint32]'0x80000001'); while($true){Start-Sleep -Seconds 3600}";
      return spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { ...opts, windowsHide: true });
    }
  } catch {
    /* no such tool on this system: the computer just follows its own sleep settings */
  }
  return null;
}
