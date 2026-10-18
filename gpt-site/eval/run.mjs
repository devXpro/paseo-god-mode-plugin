// Runs the eval: every case through `codex exec` against the stub, per variant. baseline is
// gpt-site/core at a git tag (--baseline-ref, default v0.5.0), current is gpt-site/core as it is.
//
//   node eval/run.mjs --out after --variants current --filter '^(core|w)\.' --parallel 4
//
// Options: --variants (baseline, current), --filter (regex over case ids), --block (core|write|probe),
// --repeat N, --parallel N, --model, --effort, --dry-run. Results land in eval/results/<out>/.
//
// Safety: the only MCP server is the stub; ChatGPT apps, plugins, user config, shell, web search
// and the rest are off. Any event that is not a message, reasoning or a stub tool call aborts the
// whole eval.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { CASES } from "./cases.mjs";
import { createOps } from "./ops.mjs";
import { createWorld } from "./world.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SITE = join(HERE, "..");
const CODEX = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex";
const NODE = process.execPath;
const WORKDIR = join(HERE, "workdir");
const VARIANTS = {
  baseline: { coreDir: join(HERE, ".baseline", "core") },
  current: { coreDir: join(SITE, "core") },
};
const DISABLED = [
  "apps", "plugins", "remote_plugin", "tool_suggest", "shell_tool", "unified_exec", "multi_agent", "image_generation",
  "goals", "sleep_tool", "view_image", "browser_use", "computer_use", "skill_search", "hooks",
];
const ALLOWED_ITEMS = new Set(["agent_message", "reasoning", "mcp_tool_call", "todo_list", "error"]);
const TIMEOUT_MS = 150_000;

const { values } = parseArgs({
  options: {
    out: { type: "string", default: `run-${new Date().toISOString().replace(/[:.]/g, "-")}` },
    variants: { type: "string", default: "baseline,current" },
    "baseline-ref": { type: "string", default: "v0.5.0" },
    filter: { type: "string" },
    block: { type: "string" },
    repeat: { type: "string", default: "1" },
    parallel: { type: "string", default: "4" },
    model: { type: "string", default: "gpt-6.1-sol" },
    effort: { type: "string", default: "low" },
    "dry-run": { type: "boolean", default: false },
  },
});

const OUT = join(HERE, "results", values.out);
mkdirSync(OUT, { recursive: true });
mkdirSync(WORKDIR, { recursive: true });
const NOW = Date.now();

// ---- Versions under test --------------------------------------------------------------------

// The released core, read from git: everything the model sees, with the relay code replaced.
function extractBaseline(ref) {
  const dir = VARIANTS.baseline.coreDir;
  const stamp = join(dir, ".ref");
  if (existsSync(stamp) && readFileSync(stamp, "utf8") === ref) return;
  mkdirSync(dir, { recursive: true });
  for (const file of ["mcp.mjs", "text.mjs", "build.mjs", "version.mjs"]) {
    writeFileSync(join(dir, file), execFileSync("git", ["-C", SITE, "show", `${ref}:gpt-site/core/${file}`], { encoding: "utf8" }));
  }
  // The eval never loads the real paseo.mjs: it opens relay connections.
  writeFileSync(join(dir, "paseo.mjs"), "export class PaseoOffline extends Error {}\n");
  writeFileSync(stamp, ref);
}

const cores = new Map();
async function loadCore(variant) {
  if (!cores.has(variant)) {
    const dir = VARIANTS[variant].coreDir;
    cores.set(variant, {
      mcp: await import(join(dir, "mcp.mjs")),
      text: await import(join(dir, "text.mjs")),
      paseo: await import(join(dir, "paseo.mjs")),
      version: (await import(join(dir, "version.mjs"))).VERSION,
      slash: await import(join(dir, "slash.mjs")).catch(() => null),
    });
  }
  return cores.get(variant);
}

// ---- Prompts: the earlier conversation, rendered by the version under test from the fake world --

async function renderPrompt(testCase, variant) {
  const steps = testCase.context ?? [];
  if (steps.length === 0) return { prompt: testCase.phrase, replay: [] };
  const core = await loadCore(variant);
  const { ops } = createOps({ world: createWorld(NOW), scenario: testCase.scenario ?? {}, text: core.text, slash: core.slash, PaseoOffline: core.paseo.PaseoOffline, siteVersion: core.version });
  const config = core.mcp.readConfig({ PASEO_PAIRING_URL: "eval://stub-no-network", PASEO_LANGUAGE: "ru", PASEO_LOG: "off" });
  const handle = core.mcp.createMcpHandler({ config, ops, log: null, caller: { identified: true } });
  const lines = ["[Earlier in this conversation]"];
  const replay = [];
  for (const step of steps) {
    if (step.user) lines.push(`User: ${step.user}`);
    else if (step.assistant) lines.push(`You said: ${step.assistant}`);
    else if (step.call) {
      replay.push({ tool: step.call, args: step.args });
      const response = await handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: step.call, arguments: step.args } });
      const result = response.result;
      const body = result.isError ? `an error: ${result.content[0].text}` : JSON.stringify(result.structuredContent ?? result.content[0].text);
      lines.push(`You called paseo_remote.${step.call}(${JSON.stringify(step.args)}) and got ${body}`);
    }
  }
  lines.push("", "[Now]", `User: ${testCase.phrase}`);
  return { prompt: lines.join("\n"), replay };
}

// ---- One run --------------------------------------------------------------------------------

const toml = (value) => JSON.stringify(value);

function codexArgs(runConfigPath, prompt) {
  const server = `{command=${toml(NODE)},args=[${toml(join(HERE, "stub.mjs"))},${toml(runConfigPath)}],required=true,startup_timeout_sec=20,tool_timeout_sec=30,default_tools_approval_mode="approve",omit_tools_from=["code_mode","deferred"]}`;
  return [
    "exec", "--json", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check",
    "-C", WORKDIR, "-s", "read-only",
    "-m", values.model, "-c", `model_reasoning_effort=${toml(values.effort)}`,
    "-c", `model_instructions_file=${toml(join(HERE, "system.md"))}`,
    ...DISABLED.flatMap((feature) => ["--disable", feature]),
    "-c", 'web_search="disabled"', "-c", "project_root_markers=[]", "-c", "skills.include_instructions=false",
    "-c", "include_permissions_instructions=false", "-c", "include_environment_context=false",
    "-c", "include_apps_instructions=false", "-c", "include_collaboration_mode_instructions=false",
    "-c", `mcp_servers.paseo_remote=${server}`,
    prompt,
  ];
}

class Unsafe extends Error {}

function parseEvents(raw) {
  const calls = new Map();
  const messages = [];
  const problems = [];
  let usage = null;
  let failure = null;
  for (const line of raw.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === "turn.completed") usage = event.usage;
    if (event.type === "turn.failed") failure = event.error?.message ?? "turn failed";
    if (event.type === "error") failure = event.message ?? "error";
    const item = event.item;
    if (!item) continue;
    if (!ALLOWED_ITEMS.has(item.type)) problems.push(`item type ${item.type}`);
    if (item.type === "mcp_tool_call") {
      if (item.server !== "paseo_remote") problems.push(`tool call to server ${item.server}`);
      const previous = calls.get(item.id) ?? {};
      calls.set(item.id, { ...previous, server: item.server, tool: item.tool, args: item.arguments ?? {}, status: item.status, result: item.result ?? previous.result ?? null, error: item.error ?? null });
    }
    if (item.type === "agent_message" && event.type === "item.completed") messages.push(item.text);
  }
  return {
    calls: [...calls.values()].map((call) => ({
      tool: call.tool,
      args: call.args,
      status: call.status,
      structured: call.result?.structured_content ?? null,
      text: call.result?.content?.map((c) => c.text).filter(Boolean).join("\n") ?? null,
      error: call.error?.message ?? null,
    })),
    final: messages.filter((m) => m && m.trim()).join(" "),
    messages,
    usage,
    failure,
    problems,
  };
}

async function runOne(job) {
  const dir = join(OUT, "runs", job.variant, `${job.case.id}.r${job.rep}`);
  mkdirSync(dir, { recursive: true });
  const runConfig = {
    coreDir: VARIANTS[job.variant].coreDir,
    scenario: { ...(job.case.scenario ?? {}), replay: job.replay },
    callLog: join(dir, "stub-calls.jsonl"),
    now: NOW,
    language: "ru",
  };
  const runConfigPath = join(dir, "run.json");
  writeFileSync(runConfigPath, JSON.stringify(runConfig, null, 2));
  writeFileSync(join(dir, "prompt.txt"), job.prompt);
  const started = Date.now();
  const child = spawn(CODEX, codexArgs(runConfigPath, job.prompt), { cwd: WORKDIR, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env } });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS);
  const code = await new Promise((resolve) => child.on("close", resolve));
  clearTimeout(timer);
  writeFileSync(join(dir, "events.jsonl"), stdout);
  writeFileSync(join(dir, "stderr.txt"), stderr);
  const parsed = parseEvents(stdout);
  const stubCalls = existsSync(runConfig.callLog)
    ? readFileSync(runConfig.callLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.rpc === "tools/call")
    : [];
  const result = {
    variant: job.variant,
    case: job.case.id,
    rep: job.rep,
    exit: code,
    durationMs: Date.now() - started,
    timedOut: Date.now() - started >= TIMEOUT_MS,
    stubToolCalls: stubCalls.length,
    ...parsed,
  };
  writeFileSync(join(dir, "result.json"), JSON.stringify(result, null, 2));
  if (parsed.problems.length) throw new Unsafe(`${job.variant} ${job.case.id}: ${parsed.problems.join("; ")}`);
  return result;
}

// ---- Jobs -----------------------------------------------------------------------------------

const filter = values.filter ? new RegExp(values.filter) : null;
const cases = CASES.filter((c) => (!filter || filter.test(c.id)) && (!values.block || c.block === values.block));
const variants = values.variants.split(",").map((v) => v.trim()).filter(Boolean);
for (const v of variants) if (!VARIANTS[v]) throw new Error(`unknown variant ${v}`);

if (variants.includes("baseline")) extractBaseline(values["baseline-ref"]);
const prompts = new Map();
for (const c of cases) for (const variant of variants) prompts.set(`${variant}|${c.id}`, await renderPrompt(c, variant));

const jobs = [];
for (let rep = 1; rep <= Number(values.repeat); rep += 1) {
  for (const c of cases) {
    for (const variant of variants) {
      const { prompt, replay } = prompts.get(`${variant}|${c.id}`);
      jobs.push({ variant, case: c, rep, prompt, replay });
    }
  }
}

writeFileSync(join(OUT, "meta.json"), JSON.stringify({ model: values.model, effort: values.effort, variants, baselineRef: values["baseline-ref"], cases: cases.map((c) => c.id), jobs: jobs.length, startedAt: new Date(NOW).toISOString() }, null, 2));
console.log(`${jobs.length} run(s): ${cases.length} case(s) × [${variants.join(", ")}] × ${values.repeat}; model ${values.model} (${values.effort}); out ${OUT}`);
if (values["dry-run"]) {
  for (const j of jobs.slice(0, 3)) console.log(`--- ${j.variant} ${j.case.id}\n${j.prompt}`);
  process.exit(0);
}

const resultsFile = join(OUT, "results.jsonl");
let next = 0;
let done = 0;
let aborted = null;
async function worker() {
  while (next < jobs.length && !aborted) {
    const job = jobs[next++];
    try {
      const r = await runOne(job);
      appendFileSync(resultsFile, `${JSON.stringify(r)}\n`);
      done += 1;
      const calls = r.calls.map((c) => c.tool).join("→") || "—";
      console.log(`[${done}/${jobs.length}] ${job.variant.padEnd(9)} ${job.case.id.padEnd(32)} ${calls}${r.failure ? `  FAIL: ${r.failure.slice(0, 80)}` : ""}  (${Math.round(r.durationMs / 1000)} s, in ${r.usage?.input_tokens ?? "?"}/cached ${r.usage?.cached_input_tokens ?? "?"}, out ${r.usage?.output_tokens ?? "?"})`);
    } catch (error) {
      if (error instanceof Unsafe) {
        aborted = error.message;
        console.error(`ABORT (safety): ${error.message}`);
      } else {
        console.error(`run failed ${job.variant} ${job.case.id}: ${error.message}`);
      }
    }
  }
}
await Promise.all(Array.from({ length: Number(values.parallel) }, worker));
if (aborted) {
  console.error(`Eval aborted: ${aborted}`);
  process.exit(3);
}
console.log(`done: ${done}/${jobs.length}; results in ${resultsFile}`);
