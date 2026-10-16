// Puts the Site source shipped with this plugin into the private checkout, file for file.
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { runOrThrow } from "../process.ts";

// Kept across releases: git history, and installed packages so `npm ci` stays fast.
const KEEP = new Set([".git", "node_modules"]);

/** The source files git would publish: tracked plus untracked-but-not-ignored, so a local development
 *  install releases what is on disk without needing a commit first. */
export async function sourceFiles(sourceDir: string): Promise<string[]> {
  const out = await runOrThrow("git", ["-C", sourceDir, "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "."]);
  return [...new Set(out.split("\0").filter(Boolean))].filter((file) => existsSync(join(sourceDir, file)));
}

export async function stageSource(sourceDir: string, checkoutDir: string): Promise<number> {
  await mkdir(checkoutDir, { recursive: true, mode: 0o700 });
  for (const entry of await readdir(checkoutDir)) {
    if (!KEEP.has(entry)) await rm(join(checkoutDir, entry), { recursive: true, force: true });
  }
  const files = await sourceFiles(sourceDir);
  for (const file of files) {
    await mkdir(dirname(join(checkoutDir, file)), { recursive: true });
    await copyFile(join(sourceDir, file), join(checkoutDir, file));
  }
  return files.length;
}

/** The per-install hosting file: the shipped template plus this user's Site. */
export async function writeHosting(checkoutDir: string, projectId: string): Promise<void> {
  const template = JSON.parse(await readFile(join(checkoutDir, ".openai", "hosting.template.json"), "utf8"));
  await writeFile(join(checkoutDir, ".openai", "hosting.json"), `${JSON.stringify({ ...template, project_id: projectId }, null, 2)}\n`);
}
