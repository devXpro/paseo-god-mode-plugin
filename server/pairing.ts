// The pairing link is a full key to this Paseo daemon. God Mode never stores it: it asks the daemon
// for it at the moment the Site needs it and hands it straight to Sites as a secret.
import { runOrThrow } from "./process.ts";

export async function readPairingUrl(): Promise<string> {
  const cli = process.env.PASEO_CLI;
  if (!cli) throw new Error("The Paseo CLI was not handed to the plugin; update Paseo.");
  const pairing = JSON.parse(await runOrThrow(cli, ["pair", "--json"], { timeoutMs: 30_000 }));
  if (!pairing.relayEnabled || typeof pairing.url !== "string") {
    throw new Error("The relay is off. Turn it on in Paseo's settings so ChatGPT can reach this Mac.");
  }
  return pairing.url;
}
