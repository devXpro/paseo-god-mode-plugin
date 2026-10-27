// The eval's MCP server, launched by Codex over stdio: one per run. It serves a variant's real
// createMcpHandler (instructions, tool list, argument checks) on top of the fake operations in
// ops.mjs, so write tools only change an in-memory world. It reads no secrets and opens no
// sockets. Usage: node stub.mjs <run-config.json>
import { appendFileSync, readFileSync } from "node:fs";
import readline from "node:readline";
import { createOps } from "./ops.mjs";
import { createWorld } from "./world.mjs";

const run = JSON.parse(readFileSync(process.argv[2], "utf8"));
const mcp = await import(`${run.coreDir}/mcp.mjs`);
const text = await import(`${run.coreDir}/text.mjs`);
const { PaseoOffline } = await import(`${run.coreDir}/paseo.mjs`);
const { VERSION } = await import(`${run.coreDir}/version.mjs`);
// Slash commands exist from 0.10.0; an older version has no slash.mjs.
const slash = await import(`${run.coreDir}/slash.mjs`).catch(() => null);
// The runtime catalog exists from 0.11.0; an older version has no models.mjs.
const models = await import(`${run.coreDir}/models.mjs`).catch(() => null);
// Answering an agent's questions exists from 0.15.0; an older version has no questions.mjs.
const questions = await import(`${run.coreDir}/questions.mjs`).catch(() => null);

const record = (entry) => appendFileSync(run.callLog, `${JSON.stringify({ at: Date.now(), ...entry })}\n`);
const { ops, state } = createOps({ world: createWorld(run.now), scenario: run.scenario ?? {}, text, slash, models, questions, PaseoOffline, siteVersion: VERSION, record });
const config = mcp.readConfig({ PASEO_PAIRING_URL: "eval://stub-no-network", PASEO_LANGUAGE: run.language ?? "ru", PASEO_LOG: "off" });
const handle = mcp.createMcpHandler({ config, ops, log: null, caller: { identified: true } });

// Bring the world to where the case's earlier conversation left it, without recording.
state.recording = false;
for (const step of run.scenario?.replay ?? []) {
  await handle({ jsonrpc: "2.0", id: 0, method: "tools/call", params: { name: step.tool, arguments: step.args } });
}
state.recording = true;

readline.createInterface({ input: process.stdin }).on("line", async (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.method) record({ rpc: message.method, tool: message.params?.name });
  const response = await handle(message);
  if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
});
