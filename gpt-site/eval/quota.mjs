// Prints how much of the Codex usage windows this login has used, without a model call
// (app-server account/rateLimits/read). Prints no account ids or tokens.
import { spawn } from "node:child_process";
import readline from "node:readline";

const child = spawn("/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex", ["app-server"], { stdio: ["pipe", "pipe", "ignore"] });
const pending = new Map();
let nextId = 1;
readline.createInterface({ input: child.stdout }).on("line", (line) => {
  try {
    const message = JSON.parse(line);
    if (pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  } catch {}
});
const call = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
const timer = setTimeout(() => {
  console.log("timeout");
  child.kill();
  process.exit(1);
}, 30_000);

await call("initialize", { clientInfo: { name: "god-mode-eval-quota", version: "0.0.1" } });
child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
const response = await call("account/rateLimits/read", {});
const window = (w) => (w ? `${w.usedPercent}% of ${w.windowDurationMins ?? "?"} min, resets ${w.resetsAt ? new Date(w.resetsAt * 1000).toLocaleString() : "?"}` : "n/a");
if (response.error) console.log(`error: ${JSON.stringify(response.error).slice(0, 200)}`);
const r = response.result ?? {};
const buckets = r.rateLimitsByLimitId ?? { default: r.rateLimits };
for (const [id, snap] of Object.entries(buckets)) {
  if (!snap) continue;
  console.log(`${id} (${snap.limitName ?? snap.normalModelSlug ?? "-"}): primary ${window(snap.primary)}; secondary ${window(snap.secondary)}${snap.rateLimitReachedType ? `; reached: ${snap.rateLimitReachedType}` : ""}`);
}
console.log(`ordinary usage allowed: ${r.ordinaryUsageAllowed}`);
clearTimeout(timer);
child.kill();
