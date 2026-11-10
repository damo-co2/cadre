import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmdirSync, rmSync, symlinkSync } from "node:fs";
import { dirname } from "node:path";

/**
 * The sandbox used to live inside the data folder. Move it to its new home once, and leave a
 * link behind so paths Bots saved earlier (in notes, memories, routines) still resolve.
 */
export function moveOldWorkspace(oldDir: string, newDir: string): void {
  if (oldDir === newDir || !existsSync(oldDir)) return;
  if (lstatSync(oldDir).isSymbolicLink()) return;
  if (existsSync(newDir)) {
    if (readdirSync(newDir).length > 0) return; // never merge into a folder that already has things in it
    rmdirSync(newDir);
  }
  mkdirSync(dirname(newDir), { recursive: true });
  try {
    renameSync(oldDir, newDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    cpSync(oldDir, newDir, { recursive: true, preserveTimestamps: true });
    rmSync(oldDir, { recursive: true, force: true });
  }
  try {
    symlinkSync(newDir, oldDir);
  } catch {
    /* the link is a convenience only */
  }
  console.log(`[cadre] sandbox moved to ${newDir}`);
}
