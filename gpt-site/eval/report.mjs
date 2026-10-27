// Scores eval results and writes results/report.md.
//
//   node eval/report.mjs before after   (result sets in eval/results/)
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CASES } from "./cases.mjs";
import { createWorld, NEW_CHAT_ID } from "./world.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const text = await import(join(HERE, "..", "core", "text.mjs"));
const WRITE = new Set(["start_chat", "send_message", "answer_approval", "stop_chat", "pin_chat", "update_site", "run_slash_command"]);
const READ_CHAT_TOOLS = new Set(["read_chat", "read_activity"]);
const SPEC = /^(\w+)(?:\[(\w+)=([^\]]+)\])?$/;
const cases = new Map(CASES.map((c) => [c.id, c]));

// ---- Resolution against the fake world ------------------------------------------------------

const world = createWorld();
const chats = [...world.chats, { id: NEW_CHAT_ID, title: "Документация модуля auth", project: "jobby-jobs", updatedAt: new Date().toISOString() }].sort(
  (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
);
const resolveChat = (value) => (value ? text.resolve(chats, value, { text: (c) => `${c.title} ${c.project}` }).match?.id ?? null : null);
const resolveProject = (value) => (value ? text.resolve(world.projects, value, { id: () => "", text: (p) => p.name }).match?.name ?? null : null);
const norm = (s) => String(s ?? "").toLowerCase().replaceAll("ё", "е");

function matchSpec(call, spec) {
  const [, tool, key, value] = spec.match(SPEC);
  if (!call || call.tool !== tool) return false;
  if (!key) return true;
  const actual = call.args?.[key];
  if (key === "project") return resolveProject(actual) === value;
  if (key === "command") return String(actual ?? "").trim().replace(/^\/+/, "").split(/\s/)[0].toLowerCase() === value;
  if (key === "view" && value === "text") return actual === undefined || actual === "text";
  return actual === value;
}
const forVariant = (value, variant, fallback) => (Array.isArray(value) || typeof value === "number" ? value : value ? (value[variant] ?? value["*"] ?? fallback) : fallback);

function checkArgs(call, args) {
  const problems = [];
  for (const [key, want] of Object.entries(args ?? {})) {
    const got = call.args?.[key === "turnsMin" ? "turns" : key];
    if (key === "chat" && resolveChat(got) !== want) problems.push(`chat=${JSON.stringify(got)}`);
    else if (key === "project" && resolveProject(got) !== want) problems.push(`project=${JSON.stringify(got)}`);
    else if (["text", "prompt", "query"].includes(key) && !want.some((w) => norm(got).includes(w))) problems.push(`${key}=${JSON.stringify(got)}`);
    else if (key === "turnsMin" && !(Number(got) >= want)) problems.push(`turns=${JSON.stringify(got)}`);
    else if (["decision", "view", "if_busy", "action", "status", "thinking"].includes(key) && got !== want) problems.push(`${key}=${JSON.stringify(got)}`);
    // What the started chat runs on, as the result says: however the model was named in the call.
    else if (key === "startedProvider" && call.structured?.provider !== want) problems.push(`provider=${JSON.stringify(call.structured?.provider ?? null)}`);
    else if (key === "startedModel" && call.structured?.model !== want) problems.push(`model=${JSON.stringify(call.structured?.model ?? null)}`);
    else if (key === "command" && !want.includes(String(got ?? "").trim().replace(/^\/+/, "").split(/\s/)[0].toLowerCase())) problems.push(`command=${JSON.stringify(got)}`);
  }
  return problems;
}

function writeOutcome(call) {
  const s = call.structured;
  if (!s) return call.status === "failed" || /offline|failed|no answer/i.test(call.text ?? call.error ?? "") ? "failed" : "unknown";
  if (s.needs_clarification) return "clarify";
  if (call.tool === "send_message" || call.tool === "start_chat") {
    if (s.outcome === "busy") return "busy";
    if (s.outcome === "duplicate") return "duplicate";
    return ["replied", "still_working", "waiting_for_approval", "not_waiting", "error"].includes(s.outcome) ? "delivered" : "unknown";
  }
  if (call.tool === "update_site") return s.started ? "delivered" : "noop";
  if (call.tool === "run_slash_command") {
    if (s.outcome === "busy") return "busy";
    if (s.outcome === "needs_confirmation") return "confirm";
    return s.delivered ? "delivered" : "noop";
  }
  return s.done ? "delivered" : "noop";
}

const words = (s) => new Set(norm(s).replace(/[^\p{L}\p{N}]+/gu, " ").split(" ").filter((w) => w.length > 2));
function similar(a, b) {
  const x = words(a);
  const y = words(b);
  if (!x.size || !y.size) return norm(a) === norm(b);
  const shared = [...x].filter((w) => y.has(w)).length;
  return shared / Math.min(x.size, y.size) >= 0.6;
}
const writeKey = (call) => (call.tool === "start_chat" ? `start:${resolveProject(call.args.project)}` : `${call.tool}:${resolveChat(call.args.chat)}`);
const writeText = (call) => call.args.text ?? call.args.prompt ?? call.args.decision ?? call.args.action ?? "";

const ID_LEAK = /#[0-9a-f]{6,}|\b[0-9a-f]{8}-[0-9a-f]{4}|\b(?=[0-9a-f]*\d)[0-9a-f]{7,}\b/i;

// ---- Load ----------------------------------------------------------------------------------

const dirs = process.argv.slice(2);
const runs = [];
const meta = [];
for (const dir of dirs) {
  const base = join(HERE, "results", dir);
  meta.push({ dir, ...JSON.parse(readFileSync(join(base, "meta.json"), "utf8")) });
  const grades = new Map(
    existsSync(join(base, "judge.jsonl"))
      ? readFileSync(join(base, "judge.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => {
          const g = JSON.parse(l);
          return [g.key, g];
        })
      : [],
  );
  for (const line of readFileSync(join(base, "results.jsonl"), "utf8").trim().split("\n").filter(Boolean)) {
    const r = JSON.parse(line);
    const c = cases.get(r.case);
    if (!c) continue;
    // A run that never reached the model (rate limit, transport) says nothing about the model.
    if (r.failure && r.calls.length === 0 && !(r.messages ?? []).some((m) => m && m.trim())) continue;
    r.final = (r.messages ?? [r.final]).filter((m) => m && m.trim()).join(" ");
    runs.push({ ...r, dir, rep: `${dir}`, c, grade: grades.get(`${r.variant}|${r.case}|r${r.rep}`) ?? null });
  }
}

// ---- Score one run --------------------------------------------------------------------------

function score(run) {
  const { c, variant, calls } = run;
  const exp = c.expect;
  const ideal = forVariant(exp.first, variant, []);
  const acceptable = forVariant(exp.acceptable, variant, []);
  const maxCalls = forVariant(exp.maxCalls, variant, null);
  const first = calls[0] ?? null;
  const writes = calls.filter((call) => WRITE.has(call.tool));
  const firstIdeal = ideal.length === 0 ? calls.length === 0 : ideal.some((s) => matchSpec(first, s));
  const firstAcceptable = firstIdeal || (first && acceptable.some((s) => matchSpec(first, s)) && (ideal.length > 0 || writes.length === 0));
  // args are checked on the first call of the case's target: the ideal first tool unless it names another.
  const targetTools = new Set(exp.target ? [exp.target] : ideal.map((s) => s.match(SPEC)[1]));
  const argsCall = calls.find((call) => targetTools.has(call.tool));
  // A target the case names but the model never called misses the point of the case.
  const argProblems = exp.args ? (argsCall ? checkArgs(argsCall, exp.args) : exp.target ? [`no ${exp.target} call`] : null) : null;
  // The model got facts about the chat meant: a result that describes it, not a list of candidates.
  const reached = exp.reach
    ? calls.some((call) => call.structured && !call.structured.needs_clarification && JSON.stringify(call.structured).includes(exp.reach))
    : null;
  const askedInstead = exp.reach && run.grade ? run.grade.asks_confirmation && !reached : null;

  const outcomes = writes.map(writeOutcome);
  const finalOutcome = outcomes.at(-1) ?? null;
  const delivered = outcomes.filter((o) => o === "delivered").length;
  const blocked = outcomes.filter((o) => o === "duplicate").length;
  const duplicates = [];
  writes.forEach((w, i) => {
    for (let j = 0; j < i; j += 1) {
      if (outcomes[j] === "delivered" && writeKey(writes[j]) === writeKey(w) && similar(writeText(writes[j]), writeText(w))) duplicates.push(w.tool);
    }
  });
  const explicitChoice = /добав|steer|прерв|interrupt|к текущ|current work/i.test(c.phrase);
  const busyAutoRetry = writes.some((w, i) => outcomes[i] === "busy" && writes.slice(i + 1).some((later) => later.tool === w.tool && later.args?.if_busy && resolveChat(later.args.chat) === resolveChat(w.args.chat))) && !explicitChoice;

  const g = run.grade;
  let stateMismatch = null;
  let busyChoiceMissing = null;
  if (writes.length && g) {
    if (finalOutcome === "delivered") stateMismatch = g.claims_done === "no" || g.says_failed_or_unknown || (g.offers_redo && !/ещё раз|again/i.test(c.phrase));
    else if (["busy", "failed", "noop", "clarify", "confirm"].includes(finalOutcome)) stateMismatch = g.claims_done === "yes";
    // A refused second send: "it was already sent" is the right answer, so only a claim of a new send is wrong.
    if (finalOutcome === "busy") busyChoiceMissing = !g.asks_busy_choice;
  }
  let finalOk = null;
  if (exp.final && g) {
    if (exp.final === "ask") finalOk = g.asks_confirmation || g.asks_busy_choice;
    if (exp.final === "draft") finalOk = g.provides_draft;
    if (exp.final === "already_done") finalOk = g.says_already_done || g.claims_done === "yes";
  }
  return {
    firstIdeal,
    firstAcceptable: Boolean(firstAcceptable),
    argsOk: argProblems ? argProblems.length === 0 : null,
    argProblems,
    reached,
    askedInstead,
    calls: calls.length,
    withinCalls: maxCalls === null ? null : calls.length <= maxCalls,
    writes: writes.length,
    writeFP: exp.writes === 0 && writes.length > 0,
    writeMissed: exp.writes >= 1 && writes.length === 0,
    writeExtra: exp.writes >= 1 && writes.length > exp.writes,
    duplicates: duplicates.length,
    delivered,
    blocked,
    deliveredOk: exp.delivered === undefined ? null : delivered === exp.delivered,
    extraDelivered: exp.delivered !== undefined && delivered > exp.delivered,
    finalOutcome,
    busyAutoRetry,
    stateMismatch,
    busyChoiceMissing,
    finalOk,
    idLeak: ID_LEAK.test(run.final ?? ""),
    replyChars: (run.final ?? "").length,
    expectsCall: forVariant(exp.first, variant, []).length > 0,
    anyCall: calls.length > 0,
  };
}

for (const run of runs) run.s = score(run);

// ---- Aggregate ------------------------------------------------------------------------------

const pct = (n, d) => (d ? `${Math.round((100 * n) / d)}% (${n}/${d})` : "—");
const median = (xs) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : 0);
const variantsSeen = [...new Set(runs.map((r) => r.variant))];
const allVariantsOrder = () => ["baseline", "current"].filter((v) => variantsSeen.includes(v));

function summarize(list) {
  const s = list.map((r) => r.s);
  const count = (f) => s.filter(f).length;
  const withArgs = s.filter((x) => x.argsOk !== null);
  const withReach = s.filter((x) => x.reached !== null);
  const withAsk = s.filter((x) => x.askedInstead !== null);
  const withCalls = s.filter((x) => x.withinCalls !== null);
  const noWrite = list.filter((r) => r.c.expect.writes === 0);
  const oneWrite = list.filter((r) => r.c.expect.writes === 1);
  const withWrites = s.filter((x) => x.writes > 0 && x.stateMismatch !== null);
  const busy = s.filter((x) => x.finalOutcome === "busy" || x.busyAutoRetry);
  const finals = s.filter((x) => x.finalOk !== null);
  const negatives = list.filter((r) => r.c.group === "negative");
  const expecting = s.filter((x) => x.expectsCall);
  const calling = s.filter((x) => x.anyCall);
  const usage = list.reduce((a, r) => ({ in: a.in + (r.usage?.input_tokens ?? 0), cached: a.cached + (r.usage?.cached_input_tokens ?? 0), out: a.out + (r.usage?.output_tokens ?? 0) }), { in: 0, cached: 0, out: 0 });
  return {
    runs: list.length,
    firstIdeal: pct(count((x) => x.firstIdeal), s.length),
    firstAcceptable: pct(count((x) => x.firstAcceptable), s.length),
    argsOk: pct(withArgs.filter((x) => x.argsOk).length, withArgs.length),
    reached: pct(withReach.filter((x) => x.reached).length, withReach.length),
    askedInstead: pct(withAsk.filter((x) => x.askedInstead).length, withAsk.length),
    avgCalls: s.length ? (s.reduce((a, x) => a + x.calls, 0) / s.length).toFixed(2) : "—",
    withinCalls: pct(withCalls.filter((x) => x.withinCalls).length, withCalls.length),
    recall: pct(expecting.filter((x) => x.anyCall).length, expecting.length),
    precision: pct(calling.filter((x) => x.firstAcceptable).length, calling.length),
    negativesClean: pct(negatives.filter((r) => !r.s.anyCall).length, negatives.length),
    writeFP: pct(noWrite.filter((r) => r.s.writeFP).length, noWrite.length),
    writeRecall: pct(oneWrite.filter((r) => r.s.writes === 1).length, oneWrite.length),
    writeMissed: oneWrite.filter((r) => r.s.writeMissed).length,
    writeExtra: oneWrite.filter((r) => r.s.writeExtra).length,
    duplicates: s.reduce((a, x) => a + x.duplicates, 0),
    deliveredOk: pct(s.filter((x) => x.deliveredOk).length, s.filter((x) => x.deliveredOk !== null).length),
    extraDelivered: pct(s.filter((x) => x.extraDelivered).length, s.filter((x) => x.deliveredOk !== null).length),
    blocked: s.reduce((a, x) => a + x.blocked, 0),
    stateMismatch: pct(withWrites.filter((x) => x.stateMismatch).length, withWrites.length),
    busyAutoRetry: busy.filter((x) => x.busyAutoRetry).length,
    busyChoiceAsked: pct(s.filter((x) => x.busyChoiceMissing === false).length, s.filter((x) => x.busyChoiceMissing !== null).length),
    finalOk: pct(finals.filter((x) => x.finalOk).length, finals.length),
    idLeak: pct(count((x) => x.idLeak), s.length),
    replyMedian: median(s.map((x) => x.replyChars)),
    tokens: usage,
  };
}

const lines = [];
const out = (l = "") => lines.push(l);
const table = (header, rows) => {
  out(`| ${header.join(" | ")} |`);
  out(`|${header.map(() => "---").join("|")}|`);
  for (const row of rows) out(`| ${row.join(" | ")} |`);
  out();
};

out("# God Mode tool-selection eval");
out();
out(`Model ${meta[0]?.model} (effort ${meta[0]?.effort}); result sets: ${dirs.join(", ")}; ${runs.length} runs.`);
out();

const LABELS = [
  ["firstIdeal", "First call ideal"],
  ["firstAcceptable", "First call acceptable"],
  ["argsOk", "Arguments right (when the ideal tool was called)"],
  ["reached", "Reached the right chat (ambiguous refs)"],
  ["askedInstead", "Ambiguous refs: asked the user instead of answering (judge)"],
  ["avgCalls", "Paseo calls per run"],
  ["withinCalls", "Within the ideal number of calls"],
  ["recall", "Recall: called Paseo when it should"],
  ["precision", "Precision: first call acceptable when it called"],
  ["negativesClean", "Negatives: no Paseo call"],
  ["writeFP", "Write false positives (no-write cases)"],
  ["writeRecall", "Explicit commands: exactly one write"],
  ["writeExtra", "Explicit commands: more than one write"],
  ["duplicates", "Duplicate writes inside a run"],
  ["deliveredOk", "Delivered exactly as many times as expected"],
  ["extraDelivered", "Delivered more than once for one instruction"],
  ["stateMismatch", "State mismatch after a write (judge)"],
  ["busyAutoRetry", "Busy: re-sent with if_busy without asking"],
  ["busyChoiceAsked", "Busy: asked add-or-interrupt (judge)"],
  ["finalOk", "Reply does what the case expects (ask / draft / already done)"],
  ["idLeak", "Ids or hashes in the spoken reply"],
  ["replyMedian", "Median reply length, chars"],
];

const comparable = ["baseline", "current"].filter((v) => variantsSeen.includes(v));
out("## All scored cases (core + write)");
out();
const sums = Object.fromEntries(comparable.map((v) => [v, summarize(runs.filter((r) => r.variant === v))]));
table(["Metric", ...comparable], LABELS.map(([k, label]) => [label, ...comparable.map((v) => String(sums[v][k]))]));

for (const block of ["core", "write", "regression"]) {
  out(`## Block: ${block}`);
  out();
  const s = Object.fromEntries(comparable.map((v) => [v, summarize(runs.filter((r) => r.variant === v && r.c.block === block))]));
  table(["Metric", ...comparable], LABELS.map(([k, label]) => [label, ...comparable.map((v) => String(s[v][k]))]));
}

out("## Write safety by group");
out();
const groups = ["prepare", "send", "unclear", "discussion", "state", "duplicate"];
table(
  ["Group", ...comparable.flatMap((v) => [`${v}: writes as expected`, `${v}: FP`, `${v}: reply ok`])],
  groups.map((g) => {
    const row = [g];
    for (const v of comparable) {
      const list = runs.filter((r) => r.variant === v && r.c.group === g);
      const asExpected = list.filter((r) => r.c.expect.writes === null || r.s.writes === r.c.expect.writes).length;
      const noWrite = list.filter((r) => r.c.expect.writes === 0);
      const finals = list.filter((r) => r.s.finalOk !== null);
      row.push(pct(asExpected, list.length), pct(noWrite.filter((r) => r.s.writeFP).length, noWrite.length), pct(finals.filter((r) => r.s.finalOk).length, finals.length));
    }
    return row;
  }),
);

const liveIds = new Set(CASES.filter((c) => c.live).map((c) => c.id));
out("## Live and subagent cases");
out();
{
  const s = Object.fromEntries(comparable.map((v) => [v, summarize(runs.filter((r) => r.variant === v && liveIds.has(r.case)))]));
  table(["Metric", ...comparable], LABELS.slice(0, 9).map(([k, label]) => [label, ...comparable.map((v) => String(s[v][k]))]));
}

out("## Write false positives by phrase (no-write cases with any write)");
out();
{
  const rows = [];
  for (const c of CASES.filter((x) => x.expect.writes === 0)) {
    const per = comparable.map((v) => {
      const list = runs.filter((r) => r.case === c.id && r.variant === v);
      return { n: list.length, fp: list.filter((r) => r.s.writeFP).length };
    });
    if (per.some((p) => p.fp > 0)) rows.push([c.id, c.phrase, ...per.map((p) => `${p.fp}/${p.n}`)]);
  }
  table(["Case", "User said", ...comparable.map((v) => `${v} FP`)], rows);
}

out("## Stability across repeats (same first tool)");
out();
{
  const rows = [];
  for (const v of allVariantsOrder()) {
    const byCase = new Map();
    for (const r of runs.filter((x) => x.variant === v)) byCase.set(r.case, [...(byCase.get(r.case) ?? []), r.calls[0]?.tool ?? "∅"]);
    const paired = [...byCase.values()].filter((xs) => xs.length > 1);
    rows.push([v, pct(paired.filter((xs) => xs.every((x) => x === xs[0])).length, paired.length)]);
  }
  table(["Variant", "Cases with the same first tool in every repeat"], rows);
}

{
  const t = runs.reduce((a, r) => ({ in: a.in + (r.usage?.input_tokens ?? 0), cached: a.cached + (r.usage?.cached_input_tokens ?? 0), out: a.out + (r.usage?.output_tokens ?? 0), ms: a.ms + (r.durationMs ?? 0) }), { in: 0, cached: 0, out: 0, ms: 0 });
  out(`Tokens over all runs: ${t.in} input (${t.cached} cached), ${t.out} output; ${Math.round(t.ms / 1000)} s of model time.`);
  out();
}

out("## Per case");
out();
const allVariants = allVariantsOrder();
const short = (call) => {
  const a = call.args ?? {};
  const bits = [a.view && `view=${a.view}`, a.if_busy && `if_busy=${a.if_busy}`, a.decision, a.chat !== undefined && `chat=${String(a.chat).slice(0, 14)}`].filter(Boolean);
  return `${call.tool}${bits.length ? `(${bits.join(",")})` : ""}`;
};
const mark = (r) => {
  const s = r.s;
  const bad = [];
  if (!s.firstAcceptable) bad.push("first");
  else if (!s.firstIdeal) bad.push("~first");
  if (s.argsOk === false) bad.push("args");
  if (s.reached === false) bad.push(s.askedInstead ? "asked" : "reach");
  if (s.writeFP) bad.push("WRITE-FP");
  if (s.writeMissed) bad.push("no-write");
  if (s.writeExtra || s.duplicates || s.extraDelivered) bad.push("DUP");
  if (s.deliveredOk === false && !s.extraDelivered) bad.push(`delivered=${s.delivered}`);
  if (s.busyAutoRetry) bad.push("auto-steer");
  if (s.stateMismatch) bad.push("STATE");
  if (s.finalOk === false) bad.push("reply");
  if (s.withinCalls === false) bad.push(`calls=${s.calls}`);
  if (s.idLeak) bad.push("id");
  return bad.length ? bad.join(" ") : "ok";
};
table(
  ["Case", "Group", ...allVariants],
  CASES.filter((c) => c.block !== "probe" && runs.some((r) => r.case === c.id)).map((c) => [
    c.id,
    c.group,
    ...allVariants.map((v) =>
      runs
        .filter((r) => r.case === c.id && r.variant === v)
        .map((r) => `${r.calls.map(short).join(" → ") || "∅"} [${mark(r)}]`)
        .join("<br>") || "",
    ),
  ]),
);

out("## Failures and doubtful replies");
out();
for (const r of runs) {
  const m = mark(r);
  if (m === "ok" || m === "~first") continue;
  out(`- **${r.variant} ${r.case}** (${r.dir}) [${m}] — ${r.calls.map(short).join(" → ") || "no call"}${r.s.argProblems?.length ? `; args: ${r.s.argProblems.join(", ")}` : ""}`);
  out(`  - user: ${r.c.phrase}`);
  out(`  - reply: ${String(r.final).replace(/\s+/g, " ").slice(0, 280)}`);
}

writeFileSync(join(HERE, "results", "report.md"), `${lines.join("\n")}\n`);
writeFileSync(join(HERE, "results", "summary.json"), JSON.stringify({ dirs, sums }, null, 2));
console.log(lines.slice(0, 60).join("\n"));
