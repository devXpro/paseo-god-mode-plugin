// The long-text eval: does a model read a cut answer on by itself when the question needs the rest,
// and leave it when it does not? Each case runs once through `codex exec` against stub.mjs, isolated
// like ../run.mjs, and passes when the reply holds facts that only a whole read finds and the calls
// stay within bounds. Uses the Codex usage allowance (about 0.5% of a Plus 5-hour window per case).
//
//   node eval/long/run.mjs [--filter regex] [--check] [--model gpt-6.1-sol] [--effort low]
//
// --check makes the stub refuse numbers above a schema maximum, as ChatGPT does.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const HERE = dirname(fileURLToPath(import.meta.url));
const CODEX = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex";
const DISABLED = ["apps", "plugins", "remote_plugin", "tool_suggest", "shell_tool", "unified_exec", "multi_agent", "image_generation", "goals", "sleep_tool", "view_image", "browser_use", "computer_use", "skill_search", "hooks"];
const { values } = parseArgs({ options: { filter: { type: "string" }, check: { type: "boolean", default: false }, model: { type: "string", default: "gpt-6.1-sol" }, effort: { type: "string", default: "low" } } });

const A = "«Research ChatGPT reminders read-only architecture»";
const B = "«Голосовой режим Paseo»";
// facts: what only a whole read finds; pages: at least that many search calls; most: at most that
// many calls of a tool (a gist or a count needs no paging).
const CASES = [
  { id: "answer-6-7", phrase: `В чате ${A} есть ответ агента с семью развилками. Что там в шестом и седьмом пунктах?`, facts: [/365/, /07[:.]45/] },
  { id: "subagents-all", phrase: `Что нашли все три сабагента в последнем ходе чата ${A}? Мне нужен итог каждого, ничего не упускай.`, facts: [/отложенн/i, /интерфейс|UI/i, /EventKit/i] },
  { id: "search-all", phrase: `Перечисли все места в чате ${B}, где обсуждали голос: мне нужен полный список эпизодов.`, facts: [/28/], pages: 4 },
  { id: "thinking-whole", phrase: `Как агент в чате ${A} рассуждал, когда решал, где хранить напоминания? К какому выводу пришёл?`, facts: [/SQLite/i, /WAL|бэкап|резервн/i] },
  { id: "failed-tests", phrase: `Какие тесты упали, когда агент в чате ${A} прогонял тесты?`, facts: [/reminders\.spec/i, /sync\.spec|Saved Messages|дубл/i] },
  { id: "server-error", phrase: `Что показал журнал сервера reminders-1, который агент в чате ${A} смотрел через ssh, когда гонял тесты? Была ли там ошибка?`, facts: [/disk full|диск|мест/i] },
  { id: "gist", phrase: `О чём вкратце чат ${A}?`, facts: [], most: { read_message: 0 } },
  { id: "count", phrase: `Сколько раз в чате ${B} обсуждали голос?`, facts: [/28/], most: { search_messages: 1 } },
];

const out = join(HERE, "..", "results", `long-${new Date().toISOString().replace(/[:.]/g, "-")}`);
const workdir = join(HERE, "..", "workdir");
mkdirSync(workdir, { recursive: true });
const toml = (v) => JSON.stringify(v);
let failed = 0;
for (const c of CASES.filter((x) => !values.filter || new RegExp(values.filter).test(x.id))) {
  const dir = join(out, c.id);
  mkdirSync(dir, { recursive: true });
  const log = join(dir, "calls.jsonl");
  const server = `{command=${toml(process.execPath)},args=[${toml(join(HERE, "stub.mjs"))},${toml(log)},${toml(values.check ? "1" : "0")}],required=true,startup_timeout_sec=20,tool_timeout_sec=30,default_tools_approval_mode="approve",omit_tools_from=["code_mode","deferred"]}`;
  const args = [
    "exec", "--json", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check", "-C", workdir, "-s", "read-only",
    "-m", values.model, "-c", `model_reasoning_effort=${toml(values.effort)}`, "-c", `model_instructions_file=${toml(join(HERE, "..", "system.md"))}`,
    ...DISABLED.flatMap((f) => ["--disable", f]),
    "-c", 'web_search="disabled"', "-c", "project_root_markers=[]", "-c", "skills.include_instructions=false", "-c", "include_permissions_instructions=false",
    "-c", "include_environment_context=false", "-c", "include_apps_instructions=false", "-c", "include_collaboration_mode_instructions=false",
    "-c", `mcp_servers.paseo_remote=${server}`, c.phrase,
  ];
  const started = Date.now();
  const child = spawn(CODEX, args, { cwd: workdir, stdio: ["ignore", "pipe", "pipe"] });
  let events = "";
  child.stdout.on("data", (d) => (events += d));
  child.stderr.on("data", () => {});
  const timer = setTimeout(() => child.kill("SIGKILL"), 240_000);
  await new Promise((r) => child.on("close", r));
  clearTimeout(timer);
  writeFileSync(join(dir, "events.jsonl"), events);
  let said = "";
  const unsafe = [];
  for (const line of events.split("\n")) {
    if (!line.startsWith("{")) continue;
    const e = JSON.parse(line);
    if (e.item?.type === "agent_message" && e.type === "item.completed") said += `${e.item.text} `;
    if (e.item && !["agent_message", "reasoning", "mcp_tool_call", "todo_list", "error"].includes(e.item.type)) unsafe.push(e.item.type);
    if (e.item?.type === "mcp_tool_call" && e.item.server !== "paseo_remote") unsafe.push(e.item.server);
  }
  if (unsafe.length) throw new Error(`${c.id}: the model reached outside the stub (${unsafe.join(", ")}); eval stopped`);
  const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  const answered = calls.filter((x) => !x.refused);
  const count = (tool) => answered.filter((x) => x.tool === tool).length;
  const ok =
    c.facts.every((f) => f.test(said)) &&
    Object.entries(c.most ?? {}).every(([tool, n]) => count(tool) <= n) &&
    (c.pages === undefined || count("search_messages") >= c.pages);
  if (!ok) failed += 1;
  const trail = calls.map((x) => `${x.refused ? "REFUSED " : ""}${x.tool}(${Object.entries(x.args ?? {}).filter(([k]) => k !== "chat").map(([k, v]) => `${k}=${String(v).slice(0, 24)}`).join(",")})`).join(" → ");
  console.log(`${ok ? "PASS" : "FAIL"}  ${c.id.padEnd(15)} ${Math.round((Date.now() - started) / 1000)} s  ${trail || "no calls"}\n      said: ${said.trim().replace(/\s+/g, " ").slice(0, 300)}`);
}
console.log(failed ? `\n${failed} case(s) failed; runs in ${out}` : `\nall cases passed; runs in ${out}`);
process.exit(failed ? 1 : 0);
