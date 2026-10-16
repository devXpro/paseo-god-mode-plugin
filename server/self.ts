// Where this plugin is installed. The host does not tell plugin code, so ask the daemon, which knows:
// a directory install is the directory, a Git install is its current checkout.
import { join } from "node:path";
import { PLUGIN_ID } from "../shared/contracts.ts";
import { runOrThrow } from "./process.ts";

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
