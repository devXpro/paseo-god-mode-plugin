// The long-text eval's MCP server, started by Codex over stdio: the checkout's real tool list,
// instructions and read operations over the fake Paseo in world.mjs. It opens no sockets; writes
// answer that nothing was done. With check 1 it refuses a number above a tool's schema maximum the
// way ChatGPT does before a call reaches the Site (Codex does not check).
// Usage: node stub.mjs <calls.jsonl> <check 0|1>
import { appendFileSync } from "node:fs";
import readline from "node:readline";
import * as mcp from "../../core/mcp.mjs";
import * as paseo from "../../core/paseo.mjs";
import { createDaemon } from "./world.mjs";

const [log, check = "0"] = process.argv.slice(2);
const daemon = createDaemon();
const on = (fn) => (_url, args) => fn(daemon, args);
const chats = async () => (await daemon.fetchAgents()).entries;
const ops = {
  readChat: on(paseo.readChatOn),
  readMessage: on(paseo.readMessageOn),
  readActivity: on(paseo.readActivityOn),
  searchMessages: on(paseo.searchMessagesOn),
  showImages: on(paseo.showImagesOn),
  readApproval: on(paseo.readApprovalOn),
  listPinnedChats: async () => ({ text: "No pinned chats.", data: { scope: "all projects", query: null, total: 0, pinned: [] } }),
  async listChats() {
    const list = await chats();
    return {
      text: list.map((c) => `${c.agent.title} (${c.project.projectName}): idle`).join("\n"),
      data: { scope: "all projects", query: null, include_archived: false, total: list.length, chats: list.map((c) => ({ id: c.agent.id, short_id: c.agent.id.slice(0, 7), title: c.agent.title, project: c.project.projectName, status: "idle", state: "idle" })) },
    };
  },
  async overview() {
    const list = await chats();
    return { text: `Nothing waits for the user. Chats: ${list.map((c) => c.agent.title).join("; ")}.`, data: { summary: "nothing waiting", hours: 12, waiting: [], running: [], new: [], projects: [] } };
  },
};
for (const name of ["startChat", "sendMessage", "answerApproval", "answerQuestions", "stopChat", "archiveChat", "pinChat", "setChatModel", "listModels", "listSlashCommands", "runSlashCommand", "pluginRead", "pluginAction", "releaseStatus", "releaseStart"]) {
  ops[name] = async () => ({ error: "Not available in this eval: nothing was done." });
}
const config = mcp.readConfig({ PASEO_PAIRING_URL: "eval://long-texts", PASEO_LANGUAGE: "ru", PASEO_LOG: "off" });
const handle = mcp.createMcpHandler({ config, ops, log: null, caller: { identified: true } });

// What ChatGPT answers to a number above a tool's maximum (seen live on 2026-11-03).
function refused(message) {
  const tool = mcp.TOOLS.find((t) => t.name === message.params?.name);
  for (const [key, value] of Object.entries(message.params?.arguments ?? {})) {
    const rule = tool?.inputSchema?.properties?.[key];
    if (rule && typeof value === "number" && rule.maximum !== undefined && value > rule.maximum) {
      return `Parameters failed connector schema validation: ${key} [maximum]: Value ${value.toFixed(1)} > maximum ${rule.maximum}`;
    }
  }
  return null;
}

readline.createInterface({ input: process.stdin }).on("line", async (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.method === "tools/call" && check === "1") {
    const text = refused(message);
    if (text) {
      appendFileSync(log, `${JSON.stringify({ tool: message.params?.name, args: message.params?.arguments, refused: text })}\n`);
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text }], isError: true } })}\n`);
      return;
    }
  }
  const response = await handle(message);
  if (message.method === "tools/call") {
    const s = response?.result?.structuredContent;
    appendFileSync(log, `${JSON.stringify({ tool: message.params?.name, args: message.params?.arguments, truncated: s?.truncated ?? null, next_offset: s?.next_offset ?? null })}\n`);
  }
  if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
});
