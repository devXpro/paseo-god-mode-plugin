import assert from "node:assert/strict";
import { test } from "node:test";
import { type ClaudeVoiceSettings, defaultClaudeVoiceSettings } from "../../shared/claude-voice.ts";
import { type ClaudeApp, explainNotFound, launchClaudeOnMac, listProfiles, parseInstances } from "./claude-mac.ts";
import type { RunResult, Runner } from "./mac.ts";

const ok = (stdout = ""): RunResult => ({ stdout, stderr: "", code: 0 });
const noSleep = async () => {};
const APP: ClaudeApp = { bundleId: "com.anthropic.claudefordesktop", path: "/Applications/Claude.app", version: "5.1" };
const EXE = "/Applications/Claude.app/Contents/MacOS/Claude";
const home = "/Users/me";
const exists = (path: string) => path === "/Applications/Claude.app/Contents/Info.plist" || path === `${home}/.claude-evo-data/electron`;

const settings = (change: Partial<ClaudeVoiceSettings> = {}): ClaudeVoiceSettings => ({ ...defaultClaudeVoiceSettings(), enabled: true, ...change });

/** A Mac with Claude installed; `ps` answers the given process table, the AX script the given result. */
function mac(options: { ps?: string[]; trusted?: boolean; ax?: unknown; psAfterOpen?: string[] } = {}) {
  const calls: string[] = [];
  let opened = false;
  const run: Runner = async (file, args) => {
    calls.push([file, ...args].join(" "));
    if (file.endsWith("plutil")) return ok(args[1] === "CFBundleIdentifier" ? "com.anthropic.claudefordesktop\n" : "5.1\n");
    if (file === "/bin/ps") return ok(`${(opened && options.psAfterOpen ? options.psAfterOpen : (options.ps ?? [])).join("\n")}\n`);
    if (file === "/usr/bin/open") {
      opened = true;
      return ok();
    }
    const script = args.join(" ");
    if (file.endsWith("osascript") && script.includes("AXIsProcessTrusted")) return ok(`${options.trusted ?? true}\n`);
    if (file.endsWith("osascript") && script.includes("function run(argv)")) return ok(JSON.stringify(options.ax ?? { result: "started", steps: [] }));
    return ok();
  };
  return { run, calls };
}

const axCall = (calls: string[]) => calls.find((c) => c.includes("function run(argv)"));

test("only Claude's main processes count, each with its profile", () => {
  const ps = [
    ` 4804 ${EXE}`,
    ` 5000 ${EXE} --user-data-dir=/Users/me/.claude-evo-data/electron`,
    ` 5001 /Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper --type=renderer`,
    ` 5002 /usr/bin/grep Claude`,
  ].join("\n");
  assert.deepEqual(parseInstances(ps, APP), [
    { pid: 4804, profile: "" },
    { pid: 5000, profile: "evo" },
  ]);
});

test("profiles are the ~/.claude-<name>-data directories that hold an electron/ directory", () => {
  const names = [".claude-evo-data", ".claude-amo-data", ".claude", ".claude-data", "other"];
  const has = (p: string) => p === "/h/.claude-evo-data/electron" || p === "/h/.claude-amo-data/electron";
  assert.deepEqual(listProfiles("/h", () => names, has), ["amo", "evo"]);
});

test("a running default Claude is pressed into voice through Accessibility, with the link allowed", async () => {
  const { run, calls } = mac({ ps: [` 4804 ${EXE}`] });
  const launch = await launchClaudeOnMac(settings(), { run, exists, platform: "darwin", sleep: noSleep, home });
  assert.equal(launch.outcome, "voice-started");
  assert.equal(launch.needsOneTap, false);
  const ax = axCall(calls) as string;
  assert.match(ax, / 4804 deeplink \d+ press com.anthropic.claudefordesktop$/);
  assert.ok(!calls.some((c) => c.startsWith("/usr/bin/open")), "nothing to start");
  const front = calls.findIndex((c) => c.includes("runningApplicationWithProcessIdentifier(4804)"));
  assert.ok(front >= 0 && front < calls.indexOf(ax));
});

test("with another instance running the link is not used, since macOS could send it there", async () => {
  const { run, calls } = mac({ ps: [` 4804 ${EXE}`, ` 5000 ${EXE} --user-data-dir=/Users/me/.claude-evo-data/electron`] });
  await launchClaudeOnMac(settings(), { run, exists, platform: "darwin", sleep: noSleep, home });
  assert.match(axCall(calls) as string, / 4804 no \d+ press $/);
});

test("a profile that is not running starts as its own instance, then gets pressed", async () => {
  const { run, calls } = mac({ ps: [` 4804 ${EXE}`], psAfterOpen: [` 4804 ${EXE}`, ` 6000 ${EXE} --user-data-dir=/Users/me/.claude-evo-data/electron`] });
  const launch = await launchClaudeOnMac(settings({ profile: "evo" }), { run, exists, platform: "darwin", sleep: noSleep, home });
  assert.equal(launch.outcome, "voice-started");
  assert.ok(calls.includes(`/usr/bin/open -n -a /Applications/Claude.app --env CLAUDE_CONFIG_DIR=${home}/.claude-evo-data --args --user-data-dir=${home}/.claude-evo-data/electron`));
  assert.match(axCall(calls) as string, / 6000 no \d+ press $/);
});

test("Claude not running at all is started first", async () => {
  const { run, calls } = mac({ ps: [], psAfterOpen: [` 7000 ${EXE}`] });
  await launchClaudeOnMac(settings(), { run, exists, platform: "darwin", sleep: noSleep, home });
  assert.ok(calls.includes("/usr/bin/open -b com.anthropic.claudefordesktop"));
  assert.match(axCall(calls) as string, / 7000 deeplink \d+ press com.anthropic.claudefordesktop$/);
});

test("with only a profile running, the default Claude starts beside it (open -n), not the profile brought forward", async () => {
  const { run, calls } = mac({ ps: [` 5000 ${EXE} --user-data-dir=/Users/me/.claude-evo-data/electron`], psAfterOpen: [` 5000 ${EXE} --user-data-dir=/Users/me/.claude-evo-data/electron`, ` 7000 ${EXE}`] });
  await launchClaudeOnMac(settings(), { run, exists, platform: "darwin", sleep: noSleep, home });
  assert.ok(calls.includes("/usr/bin/open -n -b com.anthropic.claudefordesktop"));
  assert.match(axCall(calls) as string, / 7000 no \d+ press $/);
});

test("the script gets what is left of Paseo's 30 s, and the process limit stays inside it", async () => {
  const timeouts: number[] = [];
  const { run, calls } = mac({ ps: [` 4804 ${EXE}`] });
  const timed: Runner = async (file, args, timeoutMs) => {
    if (args.join(" ").includes("function run(argv)")) timeouts.push(timeoutMs ?? 0);
    return run(file, args, timeoutMs);
  };
  await launchClaudeOnMac(settings(), { run: timed, exists, platform: "darwin", sleep: noSleep, home });
  const budget = Number(/ 4804 deeplink (\d+) press/.exec(axCall(calls) as string)?.[1]);
  assert.ok(budget > 20_000 && budget <= 26_500, `budget ${budget}`);
  assert.ok(timeouts[0] > budget && timeouts[0] <= 28_000, `timeout ${timeouts[0]}`);
});

test("an unknown profile is refused before anything starts", async () => {
  const { run, calls } = mac({ ps: [] });
  const launch = await launchClaudeOnMac(settings({ profile: "nope" }), { run, exists, platform: "darwin", sleep: noSleep, home });
  assert.equal(launch.outcome, "unsupported");
  assert.ok(!calls.some((c) => c.startsWith("/usr/bin/open")));
});

test("without Accessibility Claude only comes forward and the user taps once", async () => {
  const { run, calls } = mac({ ps: [` 4804 ${EXE}`], trusted: false });
  const launch = await launchClaudeOnMac(settings(), { run, exists, platform: "darwin", sleep: noSleep, home });
  assert.equal(launch.outcome, "app-opened");
  assert.equal(launch.needsOneTap, true);
  assert.equal(axCall(calls), undefined);
});

test("open mode never touches Claude's controls", async () => {
  const { run, calls } = mac({ ps: [` 4804 ${EXE}`] });
  const launch = await launchClaudeOnMac(settings({ macMode: "open" }), { run, exists, platform: "darwin", sleep: noSleep, home });
  assert.equal(launch.needsOneTap, true);
  assert.equal(axCall(calls), undefined);
});

test("each script result becomes an honest outcome", async () => {
  const cases: [unknown, string, boolean][] = [
    [{ result: "pressed", steps: [] }, "voice-requested", false],
    [{ result: "already-on", steps: [] }, "already-on", false],
    [{ result: "not-found", steps: [{ decision: { action: "none", reason: "draft" } }] }, "app-opened", true],
    [{ result: "timeout", steps: [] }, "app-opened", true],
    [{ result: "press-failed", why: "changed", steps: [] }, "app-opened", true],
  ];
  for (const [ax, outcome, oneTap] of cases) {
    const { run } = mac({ ps: [` 4804 ${EXE}`], ax });
    const launch = await launchClaudeOnMac(settings(), { run, exists, platform: "darwin", sleep: noSleep, home });
    assert.equal(launch.outcome, outcome);
    assert.equal(launch.needsOneTap, oneTap);
  }
});

test("a broken script answer leaves Claude open for one tap", async () => {
  const { run } = mac({ ps: [` 4804 ${EXE}`], ax: "not json" });
  const runBroken: Runner = async (file, args) => (args.join(" ").includes("function run(argv)") ? { stdout: "", stderr: "execution error", code: 1 } : run(file, args));
  const launch = await launchClaudeOnMac(settings(), { run: runBroken, exists, platform: "darwin", sleep: noSleep, home });
  assert.equal(launch.outcome, "app-opened");
  assert.equal(launch.needsOneTap, true);
});

test("the reasons read as plain words", () => {
  assert.match(explainNotFound({ result: "not-found", steps: [{ decision: { action: "none", reason: "draft" } }] }), /draft/);
  assert.match(explainNotFound({ result: "not-found", steps: [{ decision: { action: "none", reason: "no-button", screen: "elsewhere" } }] }), /not on a chat/);
  assert.match(explainNotFound({ result: "no-window", steps: [] }), /window/);
  assert.match(explainNotFound({ result: "timeout", steps: [] }), /too long/);
  assert.match(explainNotFound({ result: "press-failed", why: "changed", steps: [] }), /changed/);
});

test("anything but a Mac is refused", async () => {
  const { run } = mac();
  const launch = await launchClaudeOnMac(settings(), { run, exists, platform: "linux", sleep: noSleep, home });
  assert.equal(launch.outcome, "unsupported");
});
