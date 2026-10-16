// The deployment archive Sites expects for a Worker build: dist/ with the hosting file and the
// database migrations beside it, as a gzipped tar.
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runOrThrow } from "../process.ts";

export async function packageWorker(checkoutDir: string, archive: string): Promise<{ bytes: number; entries: number }> {
  if (!existsSync(join(checkoutDir, "dist", "server", "index.js"))) throw new Error("The build left no dist/server/index.js.");
  const hosting = JSON.parse(await readFile(join(checkoutDir, ".openai", "hosting.json"), "utf8"));
  const builtFile = join(checkoutDir, "dist", ".openai", "hosting.json");
  const built = existsSync(builtFile) ? JSON.parse(await readFile(builtFile, "utf8")) : {};
  // Attribution the build emits travels with the source settings.
  if (built.artifact_metadata != null) hosting.artifact_metadata = built.artifact_metadata;

  const stage = await mkdtemp(join(tmpdir(), "god-mode-package-"));
  try {
    await cp(join(checkoutDir, "dist"), join(stage, "dist"), { recursive: true, dereference: false });
    await mkdir(join(stage, "dist", ".openai"), { recursive: true });
    await writeFile(join(stage, "dist", ".openai", "hosting.json"), `${JSON.stringify(hosting, null, 2)}\n`);
    if (existsSync(join(checkoutDir, "drizzle"))) {
      await cp(join(checkoutDir, "drizzle"), join(stage, "dist", ".openai", "drizzle"), { recursive: true });
    }
    await mkdir(dirname(archive), { recursive: true });
    await runOrThrow("tar", ["-C", stage, "-czf", archive, "dist"]);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
  const entries = (await runOrThrow("tar", ["-tzf", archive])).split("\n");
  if (!entries.includes("dist/.openai/hosting.json")) throw new Error("The archive has no dist/.openai/hosting.json.");
  return { bytes: (await stat(archive)).size, entries: entries.length };
}
