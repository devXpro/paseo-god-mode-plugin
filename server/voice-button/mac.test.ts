import assert from "node:assert/strict";
import { test } from "node:test";
import { type VoiceButtonSettings, defaultVoiceButtonSettings } from "../../shared/voice-button.ts";
import { parseHotkey } from "./hotkey.ts";
import { type RunResult, type Runner, detectVoiceHotkey, keyPressScript, launchOnMac } from "./mac.ts";

const ok = (stdout = ""): RunResult => ({ stdout, stderr: "", code: 0 });
const fail = (): RunResult => ({ stdout: "", stderr: "boom", code: 1 });
const noSleep = async () => {};
/** The ChatGPT app is in /Applications, whatever machine runs the tests. */
const exists = (path: string) => path === "/Applications/ChatGPT.app/Contents/Info.plist";

/** A Mac with the ChatGPT/Codex app installed; `extra` answers first. */
function mac(extra: (file: string, script: string, args: string[]) => RunResult | undefined = () => undefined) {
  const calls: string[] = [];
  const run: Runner = async (file, args) => {
    calls.push([file, ...args].join(" "));
    const answer = extra(file, args.join(" "), args);
    if (answer) return answer;
    if (file.endsWith("plutil")) return ok(args[1] === "CFBundleIdentifier" ? "com.openai.codex\n" : "26.1013.31256\n");
    return ok();
  };
  return { run, calls };
}

/** Paseo is trusted, ChatGPT runs and comes to the front. */
const ready = (file: string, script: string) => {
  if (file.endsWith("osascript") && script.includes("AXIsProcessTrusted")) return ok("true\n");
  if (file.endsWith("osascript") && script.includes("frontmostApplication")) return ok("com.openai.codex\n");
  if (file.endsWith("pgrep")) return ok("4242\n");
  return undefined;
};

const settings = (change: Partial<VoiceButtonSettings> = {}): VoiceButtonSettings => ({ ...defaultVoiceButtonSettings(), enabled: true, ...change });
const pressed = (calls: string[]) => calls.some((c) => c.includes("CGEventPost"));

test("accelerators become a key code and modifier flags", () => {
  assert.deepEqual(parseHotkey("cmd+shift+v"), { keyCode: 9, flags: 0x100000 | 0x20000 });
  assert.deepEqual(parseHotkey("Ctrl+Command+Alt+V"), { keyCode: 9, flags: 0x40000 | 0x100000 | 0x80000 });
  assert.deepEqual(parseHotkey(" ctrl + option + space "), { keyCode: 49, flags: 0x40000 | 0x80000 });
  assert.deepEqual(parseHotkey("F5"), { keyCode: 96, flags: 0 });
  assert.equal(parseHotkey("v"), null, "a bare letter would type into the focused app");
  assert.equal(parseHotkey("hyper+v"), null);
  assert.equal(parseHotkey(""), null);
});

test("the key press script posts key down and up with the flags", () => {
  const script = keyPressScript({ keyCode: 9, flags: 0x120000 });
  assert.match(script, /CGEventCreateKeyboardEvent\(null, 9, true\)/);
  assert.match(script, /CGEventCreateKeyboardEvent\(null, 9, false\)/);
  assert.equal(script.match(/CGEventSetFlags\(\w+, 1179648\)/g)?.length, 2);
});

test("ChatGPT's global voice shortcut wins over the in-app one, then the default", () => {
  const both = JSON.stringify([
    { command: "composer.startVoiceMode", key: "Ctrl+Command+Alt+V" },
    { command: "realtimeVoice", key: "Ctrl+Alt+Space" },
  ]);
  assert.deepEqual(detectVoiceHotkey(() => both), { command: "realtimeVoice", key: "Ctrl+Alt+Space" });
  assert.equal(detectVoiceHotkey(() => JSON.stringify([{ command: "composer.startVoiceMode", key: "Ctrl+Command+Alt+V" }])).key, "Ctrl+Command+Alt+V");
  assert.deepEqual(detectVoiceHotkey(() => null), { command: "composer.startVoiceMode", key: "Ctrl+Shift+V" });
  assert.equal(detectVoiceHotkey(() => "{broken").key, "Ctrl+Shift+V");
});

test("auto mode brings ChatGPT forward, then presses its shortcut", async () => {
  const { run, calls } = mac(ready);
  const launch = await launchOnMac(settings(), { run, exists, platform: "darwin", sleep: noSleep, detectHotkey: () => ({ command: "composer.startVoiceMode", key: "Ctrl+Command+Alt+V" }) });
  assert.equal(launch.outcome, "voice-requested");
  assert.equal(launch.needsOneTap, false);
  const front = calls.indexOf("/usr/bin/open -b com.openai.codex");
  const press = calls.findIndex((c) => c.includes("CGEventCreateKeyboardEvent(null, 9, true)") && c.includes("1835008"));
  assert.ok(front >= 0 && press > front);
});

test("a set hotkey overrides ChatGPT's", async () => {
  const { run, calls } = mac(ready);
  await launchOnMac(settings({ macMode: "hotkey", macHotkey: "cmd+shift+v" }), { run, exists, platform: "darwin", sleep: noSleep, detectHotkey: () => assert.fail("not read") });
  assert.ok(calls.some((c) => c.includes("CGEventCreateKeyboardEvent(null, 9, true)") && c.includes("1179648")));
});

test("without Accessibility it opens ChatGPT and presses nothing", async () => {
  const { run, calls } = mac((file, script) => (file.endsWith("osascript") && script.includes("AXIsProcessTrusted") ? ok("false\n") : undefined));
  const launch = await launchOnMac(settings(), { run, exists, platform: "darwin", detectHotkey: () => ({ command: "x", key: "ctrl+shift+v" }) });
  assert.equal(launch.via, "open");
  assert.equal(launch.needsOneTap, true);
  assert.match(launch.message, /Accessibility/);
  assert.ok(!pressed(calls));
});

test("keys never go to another app", async () => {
  const { run, calls } = mac((file, script) => (file.endsWith("osascript") && script.includes("frontmostApplication") ? ok("com.apple.finder\n") : ready(file, script)));
  const launch = await launchOnMac(settings(), { run, exists, platform: "darwin", sleep: noSleep, detectHotkey: () => ({ command: "x", key: "ctrl+shift+v" }) });
  assert.equal(launch.via, "open");
  assert.ok(!pressed(calls));
});

test("a closed ChatGPT starts in the background before the press", async () => {
  let checks = 0;
  const { run, calls } = mac((file, script) => (file.endsWith("pgrep") ? (++checks > 2 ? ok("1\n") : fail()) : ready(file, script)));
  const launch = await launchOnMac(settings(), { run, exists, platform: "darwin", sleep: noSleep, detectHotkey: () => ({ command: "x", key: "ctrl+shift+v" }) });
  assert.equal(launch.via, "hotkey");
  assert.ok(calls.includes("/usr/bin/open -g -b com.openai.codex"));
});

test("open mode opens ChatGPT for one tap; a failure to open is an error", async () => {
  const { run } = mac();
  const launch = await launchOnMac(settings({ macMode: "open" }), { run, exists, platform: "darwin" });
  assert.deepEqual([launch.outcome, launch.needsOneTap], ["app-opened", true]);
  const broken = mac((file) => (file === "/usr/bin/open" ? fail() : undefined));
  await assert.rejects(launchOnMac(settings({ macMode: "open" }), { run: broken.run, exists, platform: "darwin" }), /Could not open ChatGPT/);
});

test("shortcut mode runs the shortcut named after the button unless told otherwise", async () => {
  const listing = (names: string) => (file: string, _s: string, args: string[]) => (file.endsWith("shortcuts") && args[0] === "list" ? ok(names) : undefined);
  const named = mac(listing("Дуся\n"));
  const launch = await launchOnMac(settings({ name: "Дуся", macMode: "shortcut" }), { run: named.run, exists, platform: "darwin" });
  assert.equal(launch.via, "shortcut");
  assert.ok(named.calls.includes("/usr/bin/shortcuts run Дуся"));
  const missing = mac(listing("Other\n"));
  assert.equal((await launchOnMac(settings({ macMode: "shortcut" }), { run: missing.run, exists, platform: "darwin" })).via, "open");
});

test("no ChatGPT.app on disk is unsupported", async () => {
  const { run } = mac();
  assert.equal((await launchOnMac(settings(), { run, exists: () => false, platform: "darwin" })).outcome, "unsupported");
});

test("no Mac or no ChatGPT is unsupported", async () => {
  const { run, calls } = mac();
  assert.equal((await launchOnMac(settings(), { run, platform: "linux" })).outcome, "unsupported");
  assert.deepEqual(calls, []);
  const other = mac((file) => (file.endsWith("plutil") ? ok("com.example.other\n") : undefined));
  assert.equal((await launchOnMac(settings(), { run: other.run, exists, platform: "darwin" })).outcome, "unsupported");
});
