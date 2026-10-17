// Grades the spoken replies the scoring cannot read by itself: whether a reply claims the action
// was done, offers to redo it, asks the busy choice, asks to confirm, gives a draft. One codex
// exec per batch, structured output, no tools at all.
//
//   node eval/judge.mjs after [before …]    → eval/results/<set>/judge.jsonl (resumable)
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CASES } from "./cases.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CODEX = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex";
const WRITE = new Set(["start_chat", "send_message", "answer_approval", "stop_chat", "update_site"]);
const JUDGED_GROUPS = new Set(["prepare", "unclear", "discussion", "duplicate", "state", "risky", "send", "ambiguous", "live"]);
const BATCH = 15;
const DISABLED = ["apps", "plugins", "remote_plugin", "tool_suggest", "shell_tool", "unified_exec", "multi_agent", "image_generation", "goals", "sleep_tool", "view_image", "browser_use", "computer_use", "skill_search", "hooks"];

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["grades"],
  properties: {
    grades: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "claims_done", "offers_redo", "asks_busy_choice", "asks_confirmation", "provides_draft", "says_failed_or_unknown", "says_already_done"],
        properties: {
          key: { type: "string" },
          claims_done: { type: "string", enum: ["yes", "no", "unclear"] },
          offers_redo: { type: "boolean" },
          asks_busy_choice: { type: "boolean" },
          asks_confirmation: { type: "boolean" },
          provides_draft: { type: "boolean" },
          says_failed_or_unknown: { type: "boolean" },
          says_already_done: { type: "boolean" },
        },
      },
    },
  },
};

const RUBRIC = `You grade the final spoken reply of a voice assistant that controls the user's coding agents through tools.
For every item you get the user's last message, the tool calls the assistant made in this turn with their results, and the reply.
Grade only what the REPLY says (use the calls only to understand it). Fields:
- claims_done: "yes" if the reply states or clearly implies that an action on an agent was carried out (a message sent or delivered to an agent, a chat started, an approval given or denied, a chat stopped, an update started) — in this turn or earlier; "no" if it says such an action was not done, failed, or has not happened yet; "unclear" if it does neither (for example it only asks a question or only discusses).
- offers_redo: the reply offers or asks to send, start or do the same thing again (a retry or a second send).
- asks_busy_choice: the reply asks whether to add the message to the agent's current work or to interrupt it.
- asks_confirmation: the reply asks the user to confirm before acting, or asks a clarifying question about what or where to act (which chat, whether to send now, and so on).
- provides_draft: the reply contains a drafted message, prompt or task text meant for an agent.
- says_failed_or_unknown: the reply says the action failed, was not delivered, or that it is unknown whether it arrived.
- says_already_done: the reply says the same message or task was already sent or started earlier.
Return one grade per item, with its key unchanged.`;

function selectItems(dir) {
  const results = readFileSync(join(HERE, "results", dir, "results.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const cases = new Map(CASES.map((c) => [c.id, c]));
  return results
    .filter((r) => {
      const c = cases.get(r.case);
      return c && (JUDGED_GROUPS.has(c.group) || c.expect.final || r.calls.some((call) => WRITE.has(call.tool)));
    })
    .map((r) => ({
      key: `${r.variant}|${r.case}|r${r.rep}`,
      user: cases.get(r.case).phrase,
      calls: r.calls.map((call) => ({ tool: call.tool, args: call.args, result: call.structured ?? call.text ?? call.error })),
      reply: (r.messages ?? [r.final]).filter((m) => m && m.trim()).join(" "),
    }));
}

function runBatch(items, outFile) {
  const prompt = `${RUBRIC}\n\nItems:\n${JSON.stringify(items, null, 1)}`;
  const schemaFile = join(HERE, "results", "judge-schema.json");
  const lastFile = `${outFile}.last-${Date.now()}-${Math.random().toString(16).slice(2)}.json`;
  const args = [
    "exec", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check",
    "-C", join(HERE, "workdir"), "-s", "read-only", "-m", process.env.JUDGE_MODEL ?? "gpt-6.1-sol", "-c", 'model_reasoning_effort="low"',
    ...DISABLED.flatMap((f) => ["--disable", f]),
    "-c", 'web_search="disabled"', "-c", "project_root_markers=[]", "-c", "skills.include_instructions=false",
    "-c", "include_permissions_instructions=false", "-c", "include_environment_context=false", "-c", "include_apps_instructions=false",
    "--output-schema", schemaFile, "-o", lastFile, prompt,
  ];
  return new Promise((resolve) => {
    const child = spawn(CODEX, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), 240_000);
    child.on("close", () => {
      clearTimeout(timer);
      try {
        const { grades } = JSON.parse(readFileSync(lastFile, "utf8"));
        resolve(grades);
      } catch {
        console.error(`judge batch failed: ${stderr.slice(-300)}`);
        resolve([]);
      }
    });
  });
}

mkdirSync(join(HERE, "results"), { recursive: true });
writeFileSync(join(HERE, "results", "judge-schema.json"), JSON.stringify(SCHEMA));
for (const dir of process.argv.slice(2)) {
  const outFile = join(HERE, "results", dir, "judge.jsonl");
  const done = new Set(existsSync(outFile) ? readFileSync(outFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l).key) : []);
  const items = selectItems(dir).filter((i) => !done.has(i.key));
  console.log(`${dir}: ${items.length} item(s) to grade`);
  const batches = [];
  for (let i = 0; i < items.length; i += BATCH) batches.push(items.slice(i, i + BATCH));
  let next = 0;
  await Promise.all(
    Array.from({ length: 3 }, async () => {
      while (next < batches.length) {
        const batch = batches[next++];
        const grades = await runBatch(batch, outFile);
        const wanted = new Set(batch.map((b) => b.key));
        for (const g of grades) if (wanted.has(g.key)) appendFileSync(outFile, `${JSON.stringify(g)}\n`);
        console.log(`  graded ${grades.length}/${batch.length}`);
      }
    }),
  );
}
