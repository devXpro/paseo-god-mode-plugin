// The first screen of the setup: can this Mac publish the Site? Every check runs in parallel and
// fails soft, so one missing tool never hides the others.
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { promisify } from "node:util";
import type { Check } from "../shared/contracts.ts";
import { AppServer } from "./codex/app-server.ts";
import { findCodex, findExecutable } from "./codex/locate.ts";

const exec = promisify(execFile);
const CHECK_TIMEOUT_MS = 15_000;
// gpt-site/package.json engines.
const MIN_NODE: Version = [22, 13, 0];

type Version = [number, number, number];

export function parseVersion(text: string): Version | null {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

export function atLeast(version: Version, min: Version): boolean {
  for (let i = 0; i < 3; i += 1) {
    if (version[i] !== min[i]) return version[i] > min[i];
  }
  return true;
}

/** The relay a pairing offer points at. The offer itself is a full key to the daemon: it is decoded
 *  here and dropped, never returned, logged or stored. */
export function relayOf(pairingUrl: string): string | null {
  try {
    const fragment = new URL(pairingUrl).hash.replace(/^#offer=/, "");
    const offer = JSON.parse(Buffer.from(decodeURIComponent(fragment), "base64url").toString("utf8"));
    return typeof offer?.relay?.endpoint === "string" ? offer.relay.endpoint : null;
  } catch {
    return null;
  }
}

async function run(cmd: string, args: string[]): Promise<string> {
  const { stdout } = await exec(cmd, args, { timeout: CHECK_TIMEOUT_MS, maxBuffer: 1024 * 1024 });
  return stdout.trim();
}

async function checkPaseo(): Promise<Check> {
  const cli = process.env.PASEO_CLI;
  if (!cli) return { id: "paseo", ok: false, detail: "The Paseo CLI was not handed to the plugin; update Paseo." };
  const pairing = JSON.parse(await run(cli, ["pair", "--json"]));
  const relay = pairing.relayEnabled ? relayOf(pairing.url) : null;
  return relay
    ? { id: "paseo", ok: true, detail: `Relay ${relay}` }
    : { id: "paseo", ok: false, detail: "The relay is off. Turn it on in Paseo's settings so ChatGPT can reach this Mac." };
}

async function checkNode(): Promise<Check> {
  const node = await findExecutable("node");
  if (!node) return { id: "node", ok: false, detail: "Node.js is not installed. Install it from nodejs.org." };
  const version = parseVersion(await run(node, ["--version"]));
  return version && atLeast(version, MIN_NODE)
    ? { id: "node", ok: true, detail: `Node ${version.join(".")}` }
    : { id: "node", ok: false, detail: `Node ${version?.join(".") ?? "?"} is too old; ${MIN_NODE.join(".")} or newer is needed.` };
}

async function checkGit(): Promise<Check> {
  const git = await findExecutable("git");
  if (!git) return { id: "git", ok: false, detail: "Git is not installed. Run xcode-select --install or install it from git-scm.com." };
  const version = parseVersion(await run(git, ["--version"]));
  return { id: "git", ok: true, detail: `Git ${version?.join(".") ?? "found"}` };
}

/** The Codex CLI, and through it the ChatGPT login: signed in with ChatGPT, on a plan with Sites. */
async function checkCodexAndChatGPT(): Promise<Check[]> {
  const codex = await findCodex();
  if (!codex) {
    return [
      { id: "codex", ok: false, detail: "No Codex CLI found. Install the ChatGPT desktop app or the Codex CLI." },
      { id: "chatgpt", ok: false, detail: "Needs the Codex CLI first." },
    ];
  }
  const version = parseVersion(await run(codex, ["--version"]).catch(() => ""));
  const codexCheck: Check = { id: "codex", ok: true, detail: `Codex ${version?.join(".") ?? "found"}` };
  const server = await AppServer.start(codex, { cwd: homedir(), timeoutMs: CHECK_TIMEOUT_MS });
  try {
    const { account } = await server.request<{ account: { type?: string; planType?: string } | null }>("account/read", { refreshToken: false });
    if (account?.type !== "chatgpt") {
      return [codexCheck, { id: "chatgpt", ok: false, detail: "Not signed in to ChatGPT." }];
    }
    const tools = await server.listTools();
    const sites = Object.keys(tools).some((name) => name.startsWith("sites."));
    return [
      codexCheck,
      sites
        ? { id: "chatgpt", ok: true, detail: `Signed in, ${account.planType ?? "unknown"} plan, Sites available` }
        : { id: "chatgpt", ok: false, detail: `Signed in on the ${account.planType ?? "unknown"} plan, which has no ChatGPT Sites. Plus or Pro is needed.` },
    ];
  } finally {
    server.close();
  }
}

const failed = (id: Check["id"]) => (error: unknown): Check => ({ id, ok: false, detail: `Check failed: ${(error as Error).message}` });

export async function checkEnvironment(): Promise<Check[]> {
  const [paseo, node, git, codexAndChatGPT] = await Promise.all([
    checkPaseo().catch(failed("paseo")),
    checkNode().catch(failed("node")),
    checkGit().catch(failed("git")),
    checkCodexAndChatGPT().catch((error) => [failed("codex")(error), failed("chatgpt")(error)]),
  ]);
  return [paseo, ...codexAndChatGPT, node, git];
}
