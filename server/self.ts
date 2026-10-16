// Where this plugin is installed. The host does not tell plugin code, so ask the daemon, which knows:
// a directory install is the directory, a Git install is its current checkout.
import { join } from "node:path";
import { PLUGIN_ID } from "../shared/contracts.ts";
import { run, runOrThrow } from "./process.ts";

export async function pluginDir(): Promise<string> {
  const cli = process.env.PASEO_CLI;
  if (!cli) throw new Error("The Paseo CLI was not handed to the plugin; update Paseo.");
  const listing = JSON.parse(await runOrThrow(cli, ["plugin", "ls", "--json"], { timeoutMs: 30_000 }));
  const plugins: { id: string; path?: string }[] = Array.isArray(listing) ? listing : (listing.plugins ?? []);
  const self = plugins.find((p) => p.id === PLUGIN_ID);
  if (!self?.path) throw new Error("Paseo does not list the God Mode plugin's directory.");
  return self.path;
}

export const siteSourceDir = async () => join(await pluginDir(), "gpt-site");

export interface SourceIdentity {
  /** git describe: "v0.5.0" on a release tag, "v0.5.0-2-gabc1234-dirty" between releases. */
  source: string | null;
  commit: string | null;
}

/** What a release is built from. Null when the plugin directory is not a git checkout. */
export async function sourceIdentity(dir: string): Promise<SourceIdentity> {
  const git = async (args: string[]) => {
    const result = await run("git", ["-C", dir, ...args], { timeoutMs: 15_000 });
    return result.ok ? result.stdout.trim() || null : null;
  };
  const [source, commit] = await Promise.all([git(["describe", "--tags", "--always", "--dirty"]), git(["rev-parse", "HEAD"])]);
  return { source, commit };
}
