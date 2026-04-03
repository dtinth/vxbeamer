import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(scriptDir, "..");
const repoRoot = resolve(appDir, "..", "..");
const websiteDist = resolve(repoRoot, "apps", "website", "dist");
const desktopDist = resolve(appDir, "dist");

execFileSync("vp", ["run", "website#build"], {
  cwd: repoRoot,
  stdio: "inherit",
});

if (!existsSync(websiteDist)) {
  throw new Error(`Website build output not found at ${websiteDist}`);
}

rmSync(desktopDist, { force: true, recursive: true });
mkdirSync(desktopDist, { recursive: true });
cpSync(websiteDist, desktopDist, { recursive: true });
