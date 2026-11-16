// Starts Claude's voice mode on this Mac: find the Claude desktop instance (the default one or a
// profile started with --user-data-dir), start it when needed, bring it forward and press its voice
// mode button through Accessibility (see claude-ax.ts). Without Accessibility, or when the button is not
// found, Claude is left in front and the user taps its voice button once.
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ClaudeVoiceLaunch, ClaudeVoiceSettings } from "../../shared/claude-voice.ts";
import { type AxResult, claudeAxScript } from "./claude-ax.ts";
import { type Runner, isAccessibilityTrusted, runFile } from "./mac.ts";

export interface ClaudeApp {
  bundleId: string;
  path: string;
  version: string;
}

const BUNDLE_ID = "com.anthropic.claudefordesktop";

export async function findClaude(run: Runner = runFile, exists: (path: string) => boolean = existsSync): Promise<ClaudeApp | null> {
  for (const path of ["/Applications/Claude.app", join(homedir(), "Applications", "Claude.app")]) {
    const plist = join(path, "Contents", "Info.plist");
    if (!exists(plist)) continue;
    const id = await run("/usr/bin/plutil", ["-extract", "CFBundleIdentifier", "raw", plist]);
    if (id.code !== 0 || id.stdout.trim() !== BUNDLE_ID) continue;
    const version = await run("/usr/bin/plutil", ["-extract", "CFBundleShortVersionString", "raw", plist]);
    return { bundleId: BUNDLE_ID, path, version: version.stdout.trim() };
  }
  return null;
}

export interface ClaudeInstance {
  pid: number;
  /** "" for the default instance, else the profile name from ~/.claude-<name>-data. */
  profile: string;
}

/** The main processes of Claude.app (not its helpers), each with the profile its --user-data-dir names. */
export function parseInstances(ps: string, app: ClaudeApp): ClaudeInstance[] {
  const executable = `${app.path}/Contents/MacOS/Claude`;
  const out: ClaudeInstance[] = [];
  for (const line of ps.split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const command = m[2];
    if (command !== executable && !command.startsWith(`${executable} `)) continue;
    const dir = /--user-data-dir=(\S+)/.exec(command)?.[1];
    const profile = dir ? (/\.claude-([A-Za-z0-9_-]+)-data(\/|$)/.exec(dir)?.[1] ?? dir) : "";
    out.push({ pid: Number(m[1]), profile });
  }
  return out;
}

export async function listInstances(app: ClaudeApp, run: Runner = runFile): Promise<ClaudeInstance[]> {
  const result = await run("/bin/ps", ["-axww", "-o", "pid=,command="]);
  return result.code === 0 ? parseInstances(result.stdout, app) : [];
}

/** Profiles that the user's launcher aliases create: ~/.claude-<name>-data with an electron/ directory. */
export function listProfiles(home = homedir(), read: (dir: string) => string[] = (dir) => readdirSync(dir), exists: (path: string) => boolean = existsSync): string[] {
  let names: string[];
  try {
    names = read(home);
  } catch {
    return [];
  }
  return names
    .map((name) => /^\.claude-([A-Za-z0-9_-]+)-data$/.exec(name)?.[1])
    .filter((name): name is string => !!name && exists(join(home, `.claude-${name}-data`, "electron")))
    .sort();
}

export interface ClaudeLaunchDeps {
  run?: Runner;
  exists?: (path: string) => boolean;
  platform?: string;
  sleep?: (ms: number) => Promise<void>;
  home?: string;
}

const ONE_TAP = "Claude is open: tap its voice button.";
const result = (outcome: ClaudeVoiceLaunch["outcome"], via: ClaudeVoiceLaunch["via"], message: string, needsOneTap = false): ClaudeVoiceLaunch => ({
  outcome,
  via,
  needsOneTap,
  url: null,
  message,
});

/** Why the button was not pressed, in words for a toast. */
export function explainNotFound(ax: AxResult): string {
  const last = [...ax.steps].reverse().find((s) => s.decision)?.decision;
  if (ax.result === "no-window") return "Claude's window did not show up.";
  if (ax.result === "press-failed") return "Claude did not take the press.";
  if (last?.reason === "draft") return "There is a draft in Claude's message box, so its voice button is hidden.";
  if (last?.screen === "elsewhere") return "Claude is not on a chat, and no new chat could be opened.";
  if (last?.reason === "no-composer") return "Claude's message box was not found.";
  return "Claude's voice button was not found.";
}

export async function launchClaudeOnMac(
  settings: ClaudeVoiceSettings,
  { run = runFile, exists = existsSync, platform = process.platform, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), home = homedir() }: ClaudeLaunchDeps = {},
): Promise<ClaudeVoiceLaunch> {
  if (platform !== "darwin") return result("unsupported", "none", "Paseo is not running on a Mac, so it cannot open Claude here.");
  const app = await findClaude(run, exists);
  if (!app) return result("unsupported", "none", "The Claude app is not in Applications.");
  const profile = settings.profile;
  const dataDir = profile ? join(home, `.claude-${profile}-data`) : null;
  if (dataDir && !exists(join(dataDir, "electron"))) return result("unsupported", "none", `There is no Claude profile "${profile}".`);

  let instances = await listInstances(app, run);
  const target = () => instances.find((i) => i.profile === profile);
  if (!target()) {
    // A profile starts as its own instance with its own data, the way the user's launcher aliases do.
    const opened = dataDir
      ? await run("/usr/bin/open", ["-n", "-a", app.path, "--env", `CLAUDE_CONFIG_DIR=${dataDir}`, "--args", `--user-data-dir=${join(dataDir, "electron")}`])
      : await run("/usr/bin/open", ["-b", app.bundleId]);
    if (opened.code !== 0) throw new Error(`Could not open Claude: ${opened.stderr.trim()}`);
    for (let attempt = 0; attempt < 30 && !target(); attempt++) {
      await sleep(500);
      instances = await listInstances(app, run);
    }
    if (!target()) return result("app-opened", "open", `Claude took too long to start. ${ONE_TAP}`, true);
  }
  const instance = target() as ClaudeInstance;

  const bringForward = async () => {
    // `open -b` would pick whichever instance macOS likes; the pid picks this one.
    await run("/usr/bin/osascript", [
      "-l",
      "JavaScript",
      "-e",
      `ObjC.import('AppKit'); $.NSRunningApplication.runningApplicationWithProcessIdentifier(${instance.pid}).activateWithOptions(3); 'ok'`,
    ]);
  };

  if (settings.macMode === "open") {
    await bringForward();
    return result("app-opened", "open", ONE_TAP, true);
  }
  if ((await isAccessibilityTrusted(run)) !== true) {
    await bringForward();
    return result("app-opened", "open", `Paseo is not allowed in Accessibility. ${ONE_TAP}`, true);
  }

  await bringForward();
  // A link opens a new chat only in the instance macOS picks, so it is used only when there is one.
  const deepLink = instances.length === 1 ? "deeplink" : "no";
  const ran = await run("/usr/bin/osascript", ["-l", "JavaScript", "-e", claudeAxScript(), String(instance.pid), deepLink, "15000"], 60_000);
  let ax: AxResult;
  try {
    ax = JSON.parse(ran.stdout.trim()) as AxResult;
  } catch {
    console.log(`[god-mode] claude voice: the Accessibility script failed: ${ran.stderr.trim().slice(0, 400)}`);
    return result("app-opened", "open", `Could not read Claude's window. ${ONE_TAP}`, true);
  }
  console.log(`[god-mode] claude voice: ${JSON.stringify(ax).slice(0, 1500)}`);
  if (ax.result === "started") return result("voice-started", "accessibility", "Claude voice is on.");
  if (ax.result === "pressed") return result("voice-requested", "accessibility", "Pressed Claude's voice button.");
  if (ax.result === "already-on") return result("already-on", "accessibility", "Claude voice is already on.");
  return result("app-opened", "open", `${explainNotFound(ax)} ${ONE_TAP}`, true);
}
