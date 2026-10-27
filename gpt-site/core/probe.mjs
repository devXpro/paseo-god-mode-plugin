// Runs the paseo-remote operations locally against the real daemon, through
// the relay, exactly as the Site does. For trying changes before a deploy.
//
//   node core/probe.mjs overview [--hours 12]
//   node core/probe.mjs chats [--project P] [--status running|waiting|new|all] [--query Q] [--archived]
//   node core/probe.mjs pinned [--project P] [--query Q]
//   node core/probe.mjs read <chat> [--view text|commands|thinking] [--turn 1] [--turns 3] [--max N]
//   node core/probe.mjs activity [chat] [--max N]
//   node core/probe.mjs images [chat] [--turn N] [--image N] [--count N] [--save DIR]
//   node core/probe.mjs search <query…> [--project P] [--chat C] [--archived] [--scan 20] [--limit 10]
//   node core/probe.mjs models [provider]
//   node core/probe.mjs start <project> <prompt…> [--wait 15] [--provider P] [--model M] [--thinking T] [--mode M]
//   node core/probe.mjs send <chat> <text…> [--wait 15] [--if-busy steer|interrupt]
//   node core/probe.mjs approve <chat> allow|deny [--request N]
//   node core/probe.mjs stop <chat>
//   node core/probe.mjs archive <chat>
//   node core/probe.mjs pin|unpin <chat> | --workspace W
//   node core/probe.mjs plugins
//   node core/probe.mjs plugin-read <plugin> [operation] [--args JSON]
//   node core/probe.mjs plugin-act <plugin> <operation> [--args JSON] [--confirm TOKEN]
//   node core/probe.mjs commands <chat> [--query Q] [--limit 60]
//   node core/probe.mjs command <chat> <name> [args…] [--if-busy interrupt] [--confirm TOKEN] [--wait 15]
//
// --json prints the structured data instead of the text; images print their size, never their
// bytes, and --save writes them to DIR to look at. The pairing URL comes
// from PASEO_PAIRING_URL, or else from `paseo pair` on this machine. It is
// never printed.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  answerApproval,
  archiveChat,
  listChats,
  listModels,
  listPinnedChats,
  listSlashCommands,
  overview,
  pinChat,
  pluginAction,
  pluginRead,
  readActivity,
  readChat,
  runSlashCommand,
  searchMessages,
  showImages,
  sendMessage,
  startChat,
  stopChat,
} from "./paseo.mjs";

function pairingUrl() {
  if (process.env.PASEO_PAIRING_URL) return process.env.PASEO_PAIRING_URL;
  const cli = process.env.PASEO_CLI ?? "/Applications/Paseo.app/Contents/Resources/bin/paseo";
  return JSON.parse(execFileSync(cli, ["pair", "--json"], { encoding: "utf8" })).url;
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    hours: { type: "string" },
    project: { type: "string" },
    status: { type: "string" },
    query: { type: "string" },
    archived: { type: "boolean" },
    view: { type: "string" },
    turn: { type: "string" },
    turns: { type: "string" },
    max: { type: "string" },
    chat: { type: "string" },
    scan: { type: "string" },
    limit: { type: "string" },
    wait: { type: "string" },
    provider: { type: "string" },
    model: { type: "string" },
    thinking: { type: "string" },
    mode: { type: "string" },
    "if-busy": { type: "string" },
    image: { type: "string" },
    count: { type: "string" },
    save: { type: "string" },
    request: { type: "string" },
    args: { type: "string" },
    confirm: { type: "string" },
    workspace: { type: "string" },
    json: { type: "boolean" },
  },
});

const [command, first, ...rest] = positionals;
const number = (value, fallback) => (value === undefined ? fallback : Number(value));
const url = pairingUrl();
const startedAt = Date.now();

const operations = {
  overview: () => overview(url, { hours: number(values.hours, 12) }),
  chats: () =>
    listChats(url, {
      project: values.project,
      status: values.status,
      query: values.query,
      includeArchived: Boolean(values.archived),
      limit: number(values.limit, 10),
    }),
  pinned: () => listPinnedChats(url, { project: values.project, query: values.query }),
  read: () =>
    readChat(url, {
      chat: first,
      view: values.view,
      turn: number(values.turn, 1),
      turns: number(values.turns, 1),
      maxChars: number(values.max, undefined),
    }),
  activity: () => readActivity(url, { chat: first, maxChars: number(values.max, undefined) }),
  images: () =>
    showImages(url, { chat: first, turn: number(values.turn, undefined), image: number(values.image, undefined), count: number(values.count, undefined) }),
  search: () =>
    searchMessages(url, {
      query: [first, ...rest].join(" "),
      project: values.project,
      chat: values.chat,
      includeArchived: Boolean(values.archived),
      scan: number(values.scan, undefined),
      limit: number(values.limit, 10),
    }),
  models: () => listModels(url, { provider: first }),
  start: () =>
    startChat(url, {
      project: first,
      prompt: rest.join(" "),
      provider: values.provider,
      model: values.model,
      thinking: values.thinking,
      mode: values.mode,
      waitSeconds: number(values.wait, 15),
    }),
  send: () =>
    sendMessage(url, { chat: first, text: rest.join(" "), ifBusy: values["if-busy"], waitSeconds: number(values.wait, 15) }),
  approve: () => answerApproval(url, { chat: first, decision: rest[0], request: values.request }),
  stop: () => stopChat(url, { chat: first }),
  archive: () => archiveChat(url, { chat: first }),
  pin: () => pinChat(url, { chat: first, workspaceId: values.workspace, action: "pin" }),
  unpin: () => pinChat(url, { chat: first, workspaceId: values.workspace, action: "unpin" }),
  plugins: () => pluginRead(url, {}),
  "plugin-read": () => pluginRead(url, { plugin: first, operation: rest[0], args: values.args ? JSON.parse(values.args) : undefined }),
  "plugin-act": () =>
    pluginAction(url, { plugin: first, operation: rest[0], args: values.args ? JSON.parse(values.args) : undefined, confirmation: values.confirm }),
  commands: () => listSlashCommands(url, { chat: first, query: values.query, limit: number(values.limit, 60) }),
  command: () =>
    runSlashCommand(url, {
      chat: first,
      command: rest[0],
      args: rest.slice(1).join(" "),
      ifBusy: values["if-busy"],
      confirmation: values.confirm,
      waitSeconds: number(values.wait, 15),
    }),
};

if (!operations[command]) {
  console.error(`Unknown command "${command}". See the header of core/probe.mjs.`);
  process.exit(2);
}
const result = await operations[command]();
console.log(values.json ? JSON.stringify(result.data ?? result, null, 2) : (result.text ?? result.invalid ?? result.error));
for (const image of result.meta?.["god-mode/images"]?.images ?? []) {
  const bytes = Buffer.from(image.data, "base64");
  console.log(`image: turn ${image.turn} #${image.n} ${image.mime} ${bytes.length} bytes`);
  if (values.save) {
    mkdirSync(values.save, { recursive: true });
    writeFileSync(join(values.save, `turn${image.turn}-image${image.n}.${image.mime.split("/")[1]}`), bytes);
  }
}
console.log(`(${Date.now() - startedAt} ms)`);
