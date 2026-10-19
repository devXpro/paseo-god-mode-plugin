// Starts ChatGPT's voice chat on this Mac. OpenAI publishes no link or API that opens it, and the
// ChatGPT desktop app has no Shortcuts action, so the supported trigger is the app's own keyboard
// shortcut: the global "Voice chat shortcut" (realtimeVoice, Settings → General, no default) or the
// in-app "Toggle voice mode" (composer.startVoiceMode, Ctrl+Shift+V by default). Pressing it needs
// Paseo in Accessibility; without that the button opens ChatGPT and the user taps voice once.
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { VoiceButtonLaunch, VoiceButtonSettings } from "../../shared/voice-button.ts";
import { type KeyPress, parseHotkey } from "./hotkey.ts";

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

export type Runner = (file: string, args: string[], timeoutMs?: number) => Promise<RunResult>;

export const runFile: Runner = (file, args, timeoutMs = 15_000) =>
  new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
      resolve({ stdout: String(stdout), stderr: String(stderr || error?.message || ""), code });
    });
  });

export interface ChatGptApp {
  bundleId: string;
  path: string;
  version: string;
}

/** com.openai.chat is the standalone ChatGPT app; com.openai.codex the ChatGPT/Codex app that replaced it. */
const BUNDLE_IDS = ["com.openai.chat", "com.openai.codex"];

export async function findChatGpt(run: Runner = runFile): Promise<ChatGptApp | null> {
  for (const path of ["/Applications/ChatGPT.app", join(homedir(), "Applications", "ChatGPT.app")]) {
    const plist = join(path, "Contents", "Info.plist");
    if (!existsSync(plist)) continue;
    const id = await run("/usr/bin/plutil", ["-extract", "CFBundleIdentifier", "raw", plist]);
    const bundleId = id.stdout.trim();
    if (id.code !== 0 || !BUNDLE_IDS.includes(bundleId)) continue;
    const version = await run("/usr/bin/plutil", ["-extract", "CFBundleShortVersionString", "raw", plist]);
    return { bundleId, path, version: version.stdout.trim() };
  }
  return null;
}

export async function listShortcuts(run: Runner = runFile): Promise<string[]> {
  const result = await run("/usr/bin/shortcuts", ["list"]);
  if (result.code !== 0) return [];
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/** AXIsProcessTrusted() answers for the responsible app (Paseo) and never shows a prompt. */
export async function isAccessibilityTrusted(run: Runner = runFile): Promise<boolean | null> {
  const result = await run("/usr/bin/osascript", ["-l", "JavaScript", "-e", "ObjC.import('ApplicationServices'); $.AXIsProcessTrusted()"]);
  return result.code === 0 ? result.stdout.trim() === "true" : null;
}

export async function isRunning(app: ChatGptApp, run: Runner = runFile): Promise<boolean> {
  const result = await run("/usr/bin/pgrep", ["-f", `${app.path}/Contents/MacOS/`]);
  return result.code === 0 && result.stdout.trim().length > 0;
}

export async function frontmostBundleId(run: Runner = runFile): Promise<string | null> {
  const result = await run("/usr/bin/osascript", [
    "-l",
    "JavaScript",
    "-e",
    "ObjC.import('AppKit'); $.NSWorkspace.sharedWorkspace.frontmostApplication.bundleIdentifier.js",
  ]);
  return result.code === 0 ? result.stdout.trim() : null;
}

export interface DetectedHotkey {
  command: string;
  key: string;
}

const readKeybindings = () => {
  try {
    return readFileSync(join(homedir(), ".codex", "keybindings.json"), "utf8");
  } catch {
    return null;
  }
};

/** ChatGPT keeps the user's shortcut overrides in ~/.codex/keybindings.json; absent ones are its defaults. */
export function detectVoiceHotkey(readText: () => string | null = readKeybindings): DetectedHotkey {
  const fallback = { command: "composer.startVoiceMode", key: "Ctrl+Shift+V" };
  let entries: unknown;
  try {
    entries = JSON.parse(readText() ?? "[]");
  } catch {
    return fallback;
  }
  if (!Array.isArray(entries)) return fallback;
  const find = (command: string) =>
    entries
      .filter((e): e is DetectedHotkey => typeof e?.command === "string" && typeof e?.key === "string")
      .find((e) => e.command === command && parseHotkey(e.key) !== null);
  const found = find("realtimeVoice") ?? find("composer.startVoiceMode");
  return found ? { command: found.command, key: found.key } : fallback;
}

export function keyPressScript({ keyCode, flags }: KeyPress): string {
  return [
    "ObjC.import('CoreGraphics');",
    `const down = $.CGEventCreateKeyboardEvent(null, ${keyCode}, true);`,
    `$.CGEventSetFlags(down, ${flags});`,
    "$.CGEventPost(0, down);",
    "delay(0.05);",
    `const up = $.CGEventCreateKeyboardEvent(null, ${keyCode}, false);`,
    `$.CGEventSetFlags(up, ${flags});`,
    "$.CGEventPost(0, up);",
    "'ok'",
  ].join(" ");
}

export interface LaunchDeps {
  run?: Runner;
  platform?: string;
  sleep?: (ms: number) => Promise<void>;
  detectHotkey?: () => DetectedHotkey;
}

const ONE_TAP = "ChatGPT is open: tap its voice button.";
const result = (outcome: VoiceButtonLaunch["outcome"], via: VoiceButtonLaunch["via"], message: string, needsOneTap = false): VoiceButtonLaunch => ({
  outcome,
  via,
  needsOneTap,
  url: null,
  message,
});

export async function launchOnMac(
  settings: VoiceButtonSettings,
  { run = runFile, platform = process.platform, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), detectHotkey = () => detectVoiceHotkey() }: LaunchDeps = {},
): Promise<VoiceButtonLaunch> {
  if (platform !== "darwin") return result("unsupported", "none", "Paseo is not running on a Mac, so it cannot open ChatGPT here.");
  const app = await findChatGpt(run);
  if (!app) return result("unsupported", "none", "The ChatGPT app is not in Applications.");

  const openApp = async (reason: string | null) => {
    const opened = await run("/usr/bin/open", ["-b", app.bundleId]);
    if (opened.code !== 0) throw new Error(`Could not open ChatGPT: ${opened.stderr.trim()}`);
    return result("app-opened", "open", reason ? `${reason} ${ONE_TAP}` : ONE_TAP, true);
  };

  if (settings.macMode === "shortcut") {
    const name = settings.macShortcutName || settings.name;
    if (!(await listShortcuts(run)).includes(name)) return openApp(`There is no shortcut named "${name}".`);
    const ran = await run("/usr/bin/shortcuts", ["run", name], 30_000);
    return ran.code === 0 ? result("voice-requested", "shortcut", `Ran the shortcut "${name}".`) : openApp(`The shortcut "${name}" failed.`);
  }

  if (settings.macMode === "auto" || settings.macMode === "hotkey") {
    const hotkey = settings.macHotkey || (settings.macMode === "auto" ? detectHotkey().key : "");
    const keyPress = parseHotkey(hotkey);
    if (!keyPress) return openApp("No voice shortcut is set.");
    if ((await isAccessibilityTrusted(run)) !== true) return openApp("Paseo is not allowed in Accessibility.");
    if (!(await isRunning(app, run))) {
      // ChatGPT registers its shortcuts once it runs.
      await run("/usr/bin/open", ["-g", "-b", app.bundleId]);
      let started = false;
      for (let attempt = 0; attempt < 20 && !started; attempt++) {
        await sleep(500);
        started = await isRunning(app, run);
      }
      if (!started) return openApp("ChatGPT took too long to start.");
      await sleep(2_500);
    }
    // In front, an in-app shortcut reaches ChatGPT's composer too; a global one works either way.
    // Keys are never pressed into another app.
    await run("/usr/bin/open", ["-b", app.bundleId]);
    let front = false;
    for (let attempt = 0; attempt < 10 && !front; attempt++) {
      front = (await frontmostBundleId(run)) === app.bundleId;
      if (!front) await sleep(200);
    }
    if (!front) return openApp("ChatGPT did not come to the front.");
    await sleep(400);
    const pressed = await run("/usr/bin/osascript", ["-l", "JavaScript", "-e", keyPressScript(keyPress)]);
    if (pressed.code !== 0) return openApp("Could not press ChatGPT's voice shortcut.");
    return result("voice-requested", "hotkey", "Started ChatGPT voice.");
  }

  return openApp(null);
}
