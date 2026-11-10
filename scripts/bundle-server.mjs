// Bundles the server into apps/desktop/resources/server for packaging: one CommonJS file plus a
// private node_modules holding the two packages that cannot be bundled (native sqlite, Playwright),
// rebuilt against the Electron ABI since the packaged app runs the server with ELECTRON_RUN_AS_NODE.
import { build } from "esbuild";
import { execSync } from "node:child_process";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const out = resolve(root, "apps/desktop/resources/server");
const require = createRequire(import.meta.url);
const ver = (p) => require(`${p}/package.json`).version;
const electronVersion = ver("electron");

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

await build({
  entryPoints: [resolve(root, "apps/server/src/index.ts")],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  outfile: resolve(out, "index.cjs"),
  external: ["better-sqlite3", "playwright", "playwright-core", "electron"],
  sourcemap: false,
  logLevel: "info",
  define: { "process.env.CADRE_PACKAGED": '"1"' },
});

writeFileSync(
  resolve(out, "package.json"),
  JSON.stringify({ name: "cadre-server", private: true, version: ver("../apps/server"), dependencies: { "better-sqlite3": ver("better-sqlite3"), playwright: ver("playwright") } }, null, 2),
);
const sh = (cmd) => execSync(cmd, { cwd: out, stdio: "inherit" });
sh("npm install --omit=dev --no-audit --no-fund --ignore-scripts");
// better-sqlite3's prebuilt binary is for system Node; rebuild it for Electron.
sh(`"${resolve(root, "node_modules/.bin/electron-rebuild")}" -v ${electronVersion} -m . -o better-sqlite3 -f`);
// electron-builder's extraResources filter drops any "node_modules" folder, so ship it as "deps"
// and point the packaged server at it with NODE_PATH (see apps/desktop/src/main/index.ts).
rmSync(resolve(out, "deps"), { recursive: true, force: true });
renameSync(resolve(out, "node_modules"), resolve(out, "deps"));
rmSync(resolve(out, "package-lock.json"), { force: true });
console.log(`server bundle ready in ${out} (electron ${electronVersion})`);
