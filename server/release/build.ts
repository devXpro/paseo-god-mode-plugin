import { runOrThrow } from "../process.ts";

/** Installs exactly the locked dependencies, runs the Site's own tests and typecheck, then builds. */
export async function buildSite(checkoutDir: string, log: (line: string) => void): Promise<void> {
  const npm = (args: string[]) => runOrThrow("npm", args, { cwd: checkoutDir, timeoutMs: 10 * 60_000 });
  log("npm ci");
  await npm(["ci", "--no-audit", "--no-fund", "--loglevel=error"]);
  log("npm run check (tests and typecheck)");
  await npm(["run", "check"]);
  log("npm run build");
  await npm(["run", "build"]);
}
