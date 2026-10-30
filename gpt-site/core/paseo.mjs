// Paseo operations behind the God Mode tools. Each call opens one relay
// connection, does its work and closes; a Worker cannot keep a socket between
// requests. Every operation returns { text, data }: text to be read or spoken
// by ChatGPT, and data, the same facts as fields (the tools' structuredContent).
//
// The pairing URL (from `paseo pair`) is a full key to the daemon: it is passed
// in, never logged, and scrubbed from error messages.
import { parseConnectionOfferFromUrl } from "@getpaseo/protocol/connection-offer";
import { buildRelayWebSocketUrl } from "@getpaseo/protocol/daemon-endpoints";
// Unsupported import path: the public createPaseoClient cannot use the relay.
// Keep @getpaseo/* pinned and re-run core/probe.mjs before bumping it.
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  activityData,
  activityText,
  candidatesText,
  chatData,
  chatLine,
  chatQuestion,
  chatState,
  choiceLine,
  contextLine,
  contextOf,
  describePermission,
  describeRelease,
  describeStep,
  imageHint,
  imageMime,
  imageName,
  imageRef,
  imagesText,
  imageTarget,
  isStep,
  latestFirstWithin,
  normalize,
  pinnedResult,
  pinResult,
  pinRowFor,
  releaseData,
  repliedOutcome,
  resolve,
  rowQuestion,
  rowsQuestion,
  settleChat,
  settleRow,
  snippet,
  toIso,
  toolCallData,
  truncate,
  withImagePlaceholders,
  withoutImages,
} from "./text.mjs";
import {
  actionsLine,
  actionSummary,
  checkConfirmation,
  confirmationText,
  DESCRIBE_METHOD,
  issueConfirmation,
  judgeOutcome,
  otherReads,
  parseCapabilities,
  pickOperation,
  pickPlugin,
  prepareArgs,
  projectResult,
  readsLine,
  readSummary,
  resultLines,
  signature,
  targetFacts,
  UNTRUSTED_NOTE,
} from "./capabilities.mjs";
import {
  adapterFor,
  afterCommand,
  commandData,
  commandResult,
  commandText,
  compactionNote,
  confirmText,
  contextChange,
  describeCommands,
  filterCommands,
  findCommand,
  listText,
  prepareCommandArgs,
  runRisk,
  splitCommand,
  withoutRepeatAfterCompaction,
} from "./slash.mjs";
import { catalogEntry, CHANGEABLE, changeResult, chooseChange, chooseStart, modelsData, modelsText, pickProvider, runtimeOf } from "./models.mjs";
import { answeredResult, answerResponse, approvalResult, prepareAnswers, questionsNeedAnswers } from "./questions.mjs";

const CONNECT_TIMEOUT_MS = 8_000;
const MAX_WAIT_SECONDS = 25;
const CHAT_PAGE = 200;
// Workspaces per page; Paseo serves at most 200.
const WORKSPACE_PAGE = 200;
const TURN_ENTRIES = 400;
const COMMANDS_SHOWN = 8;
const MAX_TURNS = 10;
const SEARCH_SCAN = { default: 20, max: 50 };
const SEARCH_CONCURRENCY = 8;
// read_activity without a chat: which chats to ask for subagents, and how many subagents to show.
const ACTIVITY_SCAN = 12;
const ACTIVITY_RECENT_MS = 3 * 3_600_000;
const SUBAGENTS_SHOWN = 6;
const SUBAGENT_TAIL = 12;
// show_images: what one answer carries (a Paseo screenshot is 50-500 KB) and how far it looks.
const IMAGE_MAX_BYTES = 1_000_000;
const IMAGES_MAX_BYTES = 1_500_000;
const IMAGES_SHOWN = 4;
const IMAGE_RECENT_TURNS = 3;
const IMAGE_SCAN_TURNS = 10;
const IMAGE_SCAN_CHATS = 8;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class PaseoOffline extends Error {}

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

function scrub(message, offer) {
  let text = String(message ?? "");
  for (const secret of [offer.daemonPublicKeyB64, offer.serverId]) {
    if (secret) text = text.replaceAll(secret, "[redacted]");
  }
  return text;
}

async function withDaemon(pairingUrl, fn) {
  const offer = parseConnectionOfferFromUrl(pairingUrl);
  if (!offer) {
    throw new Error("PASEO_PAIRING_URL has no #offer= fragment");
  }
  const client = new DaemonClient({
    url: buildRelayWebSocketUrl({
      endpoint: offer.relay.endpoint,
      serverId: offer.serverId,
      role: "client",
      useTls: offer.relay.useTls ?? true,
    }),
    // A fresh id per connection, so parallel tool calls never look like one client.
    clientId: `god-mode-${crypto.randomUUID()}`,
    clientType: "mcp",
    connectTimeoutMs: CONNECT_TIMEOUT_MS,
    e2ee: { enabled: true, daemonPublicKeyB64: offer.daemonPublicKeyB64 },
    reconnect: { enabled: false },
  });
  try {
    await client.connect();
  } catch (error) {
    await client.close().catch(() => {});
    throw new PaseoOffline(scrub(error?.message, offer));
  }
  try {
    return await fn(client);
  } catch (error) {
    throw new Error(scrub(error?.message, offer));
  } finally {
    await client.close().catch(() => {});
  }
}

// Runs fn over items with at most `limit` in flight; results keep their order.
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function toChat({ agent, project }) {
  return {
    id: agent.id,
    title: agent.title || "(untitled)",
    project: project?.projectName ?? "(no project)",
    workspace: project?.workspaceName ?? null,
    // Paseo pins a workspace, not a chat: list_pinned_chats finds a pin's chats by this.
    workspaceId: agent.workspaceId ?? null,
    status: agent.status,
    attention: agent.requiresAttention ? agent.attentionReason : null,
    permissions: agent.pendingPermissions ?? [],
    updatedAt: agent.updatedAt,
    createdAt: agent.createdAt,
    archived: Boolean(agent.archivedAt),
    // Where the agent works: relative image paths in its messages start here.
    cwd: agent.cwd ?? null,
    // Context window and token counts; live in the daemon only, absent after a restart.
    usage: agent.lastUsage ?? null,
    // Which runtime the chat runs on (claude, codex…) and its permission mode: slash commands
    // depend on both.
    provider: agent.provider ?? null,
    mode: agent.currentModeId ?? null,
    // What it runs on, as Paseo's own chat list reports it (the runtime's report first).
    model: agent.runtimeInfo?.model ?? agent.model ?? null,
    thinking: agent.effectiveThinkingOptionId ?? agent.thinkingOptionId ?? null,
  };
}

async function fetchProjects(client) {
  const { projects } = await client.listProjects();
  return projects.map((p) => ({ name: p.projectDisplayName, directory: p.projectRootPath }));
}

async function fetchChats(client) {
  const { entries } = await client.fetchAgents({
    scope: "active",
    sort: [{ key: "updated_at", direction: "desc" }],
    page: { limit: CHAT_PAGE },
  });
  return entries.map(toChat);
}

// Paseo's own search over title, workspace, branch and project. History
// includes archived chats whatever the filter says, so they are dropped here
// unless asked for. Without a query it lists chats newest first.
async function fetchChatHistory(client, { query, includeArchived, limit }) {
  const { entries } = await client.fetchAgentHistory({
    ...(query ? { search: query } : {}),
    filter: { includeArchived: Boolean(includeArchived) },
    sort: [{ key: "updated_at", direction: "desc" }],
    page: { limit },
  });
  const chats = entries.map(toChat);
  return includeArchived ? chats : chats.filter((c) => !c.archived);
}

function clarification(kind, query, text, names) {
  return { text, data: { needs_clarification: { kind, query: String(query ?? ""), candidates: names } } };
}

// An id as the tools hand it out: the whole id, or its start (short_id, "#a1b2c3d"), 6+ characters.
const ID_PREFIX = /^[0-9a-f]{6}[0-9a-f-]*$/;

// The chat an id names, archived chats included, or the question when it names none or several.
// Null when the reference is no id, or a word that only looks like one.
async function chatById(client, chats, query, { read }) {
  const raw = String(query ?? "").trim().replace(/^#/, "").toLowerCase();
  if (!ID_PREFIX.test(raw)) return null;
  const known = UUID.test(raw) ? chats.find((c) => c.id === raw) : null;
  if (known) return { chat: known };
  // A start of an id is Paseo's to settle: it looks through every chat it keeps, archived ones
  // too, so a short id an archived chat shares is never taken for an active chat's. It answers
  // null for an unknown id and refuses a start that several ids share.
  let fetched;
  try {
    fetched = await client.fetchAgent(raw);
  } catch (error) {
    if (!/ambiguous/i.test(String(error?.message ?? ""))) throw error;
    return { ask: chatQuestion(raw, "id_prefix", chats.filter((c) => c.id.startsWith(raw)), { read }) };
  }
  if (fetched) return { chat: chats.find((c) => c.id === fetched.agent.id) ?? toChat(fetched) };
  return UUID.test(raw) ? { ask: chatQuestion(raw, "unknown_id", [], { read }) } : null;
}

// Resolves a chat reference: an id of any chat, archived ones included, or a name among active
// chats only (see settleChat: a write acts only on one whole match, never on recency or state).
// Archived chats are looked through only when the user asks (include_archived of list_chats and
// search_messages), and then reached by id. Returns { chat, note? } or { ask }.
async function pickChat(client, query, chats, { read = false } = {}) {
  const active = chats ?? (await fetchChats(client));
  const byId = await chatById(client, active, query, { read });
  if (byId) return byId;
  const settled = settleChat(active, query, { read });
  if (settled.chat) return settled;
  return { ask: chatQuestion(query, settled.ask, settled.ask === "no_match" ? settled.chats.slice(0, 3) : settled.chats, { read }) };
}

// With no match the whole project list comes back, so ChatGPT can map a spoken
// name ("прокси") to its spelling ("proxy") and retry without asking.
function pickProject(projects, query) {
  const found = resolve(projects, query, { id: () => "", text: (p) => p.name });
  if (found.match) return { project: found.match };
  if (found.candidates.length === 0) {
    const names = projects.map((p) => p.name);
    return { ask: clarification("project", query, `No project matches "${query}". Projects: ${names.join(", ")}.`, names) };
  }
  const names = found.candidates.map((p) => p.name);
  return { ask: clarification("project", query, candidatesText("project", query, names), names) };
}

function section(title, chats, limit, now) {
  if (chats.length === 0) return [];
  const lines = chats.slice(0, limit).map((c) => chatLine(c, now));
  if (chats.length > limit) lines.push(`… and ${chats.length - limit} more`);
  return [`${title}:`, ...lines];
}

const isRunning = (c) => ["running", "initializing"].includes(c.status);
const isWaiting = (c) => c.permissions.length > 0 || c.attention === "permission";

// The chat's Claude Task/Agent subagents (Paseo's provider subagents). An archived chat or one the
// daemon cannot load simply has none.
async function listSubagents(client, chatId) {
  try {
    return (await client.listProviderSubagents(chatId)).subagents ?? [];
  } catch {
    return [];
  }
}

// Marks how many subagents are working in each chat. A turn can end while backgrounded subagents
// keep going, so an idle chat may still be working.
async function countSubagents(client, chats) {
  await mapLimit(chats, SEARCH_CONCURRENCY, async (c) => {
    const subagents = await listSubagents(client, c.id);
    c.subagents = subagents;
    c.subagentsRunning = subagents.filter((s) => s.status === "running").length;
  });
}

export async function overview(pairingUrl, { hours = 12 } = {}) {
  return withDaemon(pairingUrl, async (client) => {
    const [projects, chats] = await Promise.all([fetchProjects(client), fetchChats(client)]);
    const now = Date.now();
    const since = now - hours * 3_600_000;
    const waiting = chats.filter(isWaiting);
    const busy = chats.filter((c) => !isWaiting(c) && isRunning(c));
    const recent = chats.filter((c) => !isWaiting(c) && !isRunning(c) && c.attention && Date.parse(c.updatedAt) >= since);
    await countSubagents(client, [...busy.slice(0, 8), ...recent.slice(0, 8)]);
    const running = [...busy, ...recent.filter((c) => c.subagentsRunning > 0)];
    const replies = recent.filter((c) => !(c.subagentsRunning > 0));
    const perProject = projects.map((p) => ({ name: p.name, chats: chats.filter((c) => c.project === p.name).length }));
    const summary =
      waiting.length + running.length + replies.length === 0
        ? "Nothing needs the user right now and no chat is running."
        : `${waiting.length} waiting for the user, ${running.length} running, ${replies.length} with a new reply or error.`;
    const text = [
      summary,
      ...section("Waiting for the user", waiting, 8, now),
      ...section("Running", running, 8, now),
      ...section(`New replies and errors, last ${hours} h`, replies, 8, now),
      `Projects (chats): ${perProject.map((p) => `${p.name} (${p.chats})`).join(", ")}`,
    ].join("\n");
    const data = {
      summary,
      hours,
      waiting: waiting.map((c) => chatData(c, now)),
      running: running.map((c) => chatData(c, now)),
      new: replies.map((c) => chatData(c, now)),
      projects: perProject,
    };
    return { text, data };
  });
}

const STATUS_FILTERS = {
  running: isRunning,
  waiting: isWaiting,
  new: (c) => c.attention === "finished" || c.attention === "error",
  all: () => true,
};

export async function listChats(pairingUrl, { project, status = "all", query, includeArchived = false, limit = 10 } = {}) {
  return withDaemon(pairingUrl, async (client) => {
    let scope = "all projects";
    let projectName = null;
    if (project) {
      const picked = pickProject(await fetchProjects(client), project);
      if (picked.ask) return picked.ask;
      projectName = picked.project.name;
      scope = projectName;
    }
    let chats =
      query || includeArchived
        ? await fetchChatHistory(client, { query, includeArchived, limit: CHAT_PAGE })
        : await fetchChats(client);
    // Paseo matches words as typed; spoken inflections ("флоту") fall back to
    // our own word matching over active chats.
    if (query && chats.length === 0) {
      const found = resolve(await fetchChats(client), query, { text: (c) => `${c.title} ${c.workspace ?? ""}` });
      chats = found.match ? [found.match] : found.candidates;
    }
    if (projectName) chats = chats.filter((c) => c.project === projectName);
    chats = chats.filter(STATUS_FILTERS[status] ?? STATUS_FILTERS.all);
    const now = Date.now();
    const shown = chats.slice(0, limit);
    const data = {
      scope,
      query: query ?? null,
      include_archived: includeArchived,
      total: chats.length,
      chats: shown.map((c) => chatData(c, now)),
    };
    if (chats.length === 0) {
      const what = status === "all" ? "" : `${status} `;
      return { text: `No ${what}chats in ${scope}${query ? ` matching "${query}"` : ""}.`, data };
    }
    const more = chats.length > limit ? `\n… ${chats.length - limit} more; narrow it with project, status or query.` : "";
    // Steers the next call to an id it already has instead of another lookup.
    const hint = "\nThe data carries each chat's id: pass it to the next tool; no need to list again.";
    return { text: `${chats.length} chat(s) in ${scope}:\n${shown.map((c) => chatLine(c, now)).join("\n")}${more}${hint}`, data };
  });
}

// The rows of Paseo's sidebar: every workspace, page by page, since Paseo filters them by neither
// pin nor id. Archived workspaces never come back.
async function fetchAllWorkspaces(client) {
  const all = [];
  let cursor = null;
  do {
    const { entries, pageInfo } = await client.fetchWorkspaces({ page: { limit: WORKSPACE_PAGE, ...(cursor ? { cursor } : {}) } });
    all.push(...entries);
    cursor = pageInfo?.hasMore ? pageInfo.nextCursor : null;
  } while (cursor);
  return all;
}

// The rows of the Pinned section at the top of Paseo's sidebar. Paseo pins a workspace (its
// pinnedAt), not a chat. Latest pin first, as Paseo orders them: an order the user dragged is kept
// on their device, out of the daemon's reach.
async function fetchPinned(client) {
  const pinned = (await fetchAllWorkspaces(client)).filter((w) => w.pinnedAt);
  return pinned.sort((a, b) => String(b.pinnedAt).localeCompare(String(a.pinnedAt)));
}

// A sidebar row: a workspace with its active chats, newest first.
function toRow(w, chats) {
  return {
    id: w.id,
    name: w.name,
    project: w.projectDisplayName,
    // The folder its chats work in: start_chat opens a chat there.
    directory: w.workspaceDirectory ?? w.projectRootPath ?? null,
    branch: w.gitRuntime?.currentBranch ?? null,
    pinnedAt: w.pinnedAt ?? null,
    status: w.status,
    chats: chats.filter((c) => c.workspaceId === w.id),
  };
}

// The workspace start_chat is asked to open a chat in: a workspace_id from earlier results, or a name,
// among the rows of Paseo's sidebar (within a project when one is named). Returns { place } with the
// folder to work in, or { ask }.
async function pickWorkspace(client, query, project) {
  const [workspaces, chats] = await Promise.all([fetchAllWorkspaces(client), fetchChats(client)]);
  let rows = workspaces.map((w) => toRow(w, chats));
  if (project) {
    const picked = pickProject(await fetchProjects(client), project);
    if (picked.ask) return picked;
    rows = rows.filter((r) => r.project === picked.project.name);
  }
  const raw = String(query).trim();
  const byId = rows.find((r) => r.id === raw);
  const settled = byId ? { row: byId } : settleRow(rows, raw);
  if (!settled.row) return { ask: rowsQuestion(raw, settled.ask, settled.rows) };
  const row = settled.row;
  const directory = row.directory ?? row.chats.find((c) => c.cwd)?.cwd;
  if (!directory) throw new Error(`Paseo gave no folder for the workspace "${row.name}"`);
  return { place: { name: row.project, directory, workspaceId: row.id, workspace: row.name } };
}

export async function listPinnedChats(pairingUrl, args = {}) {
  return withDaemon(pairingUrl, (client) => listPinnedChatsOn(client, args));
}

// list_pinned_chats over an open connection (tests drive it with a fake client): every pinned row
// with its active chats, newest first, in one project when asked.
export async function listPinnedChatsOn(client, { project, query } = {}) {
  const [projects, workspaces, chats] = await Promise.all([project ? fetchProjects(client) : [], fetchPinned(client), fetchChats(client)]);
  let scope = "all projects";
  if (project) {
    const picked = pickProject(projects, project);
    if (picked.ask) return picked.ask;
    scope = picked.project.name;
  }
  const rows = workspaces.filter((w) => !project || w.projectDisplayName === scope).map((w) => toRow(w, chats));
  return pinnedResult(rows, { scope, query });
}

// Loads `count` turns, newest first counted from `from` (1 = latest), each read
// back from its end so the final message is never cut off by the page size.
// Returns them oldest first, as a conversation reads.
async function loadTurns(client, agentId, from, count) {
  const index = await client.listAgentTimelinePrompts(agentId);
  const prompts = index.prompts ?? [];
  const total = prompts.length;
  const wanted = [];
  for (let turn = from + count - 1; turn >= from; turn -= 1) {
    const i = total - turn;
    if (i < 0 || i >= total) continue;
    wanted.push({
      turn,
      position: i + 1,
      start: prompts[i].seq,
      end: prompts[i + 1]?.seq ?? Infinity,
      preview: prompts[i].preview,
      startedAt: prompts[i].timestamp,
    });
  }
  if (wanted.length === 0) {
    return { total, turns: [], missing: `The chat has ${total} turn(s); turn ${from} does not exist.` };
  }
  const turns = await Promise.all(
    wanted.map(async (w) => {
      const page = await client.fetchAgentTimeline(
        agentId,
        w.end === Infinity
          ? { direction: "tail", limit: TURN_ENTRIES, projection: "projected" }
          : { direction: "before", cursor: { epoch: index.epoch, seq: w.end }, limit: TURN_ENTRIES, projection: "projected" },
      );
      const entries = page.entries.filter((e) => e.seqStart >= w.start && e.seqStart < w.end);
      return { ...w, items: entries.map((e) => e.item), endedAt: entries.at(-1)?.timestamp ?? null };
    }),
  );
  return { total, turns };
}

// A turn's parts. The agent's images become "[image N]", numbered through the turn, and come back
// separately with their sources.
function turnText(turn) {
  const items = withoutRepeatAfterCompaction(turn.items);
  const agent = [];
  const images = [];
  for (const item of items) {
    // A done compaction (a /compact, or Claude's own when the context fills up) reads as a line.
    if (item.type === "compaction" && item.status === "completed") agent.push(compactionNote(item));
    if (item.type !== "assistant_message") continue;
    const shown = withImagePlaceholders(item.text, images.length + 1);
    agent.push(shown.text);
    images.push(...shown.images);
  }
  return {
    user: items.find((i) => i.type === "user_message")?.text ?? turn.preview ?? "",
    agent,
    images,
    errors: items.filter((i) => i.type === "error").map((i) => i.message),
    calls: items.filter((i) => i.type === "tool_call"),
    // What the model shared of its reasoning: Claude's thinking (often none) or Codex's summaries.
    thinking: items.filter((i) => i.type === "reasoning").map((i) => withoutImages(i.text)),
  };
}

// The chat line read_chat opens with, and how full its context window is when Paseo knows.
function chatHeader(target) {
  return [chatLine(target), contextLine(contextOf(target.usage))].filter(Boolean).join("\n");
}

const OMITTED = /^\((\d+) earlier message\(s\) omitted\)\n\n/;

function renderTurnsText(target, loaded, max) {
  const perTurn = Math.floor(max / loaded.turns.length);
  const userMax = loaded.turns.length === 1 ? 300 : 200;
  const shaped = loaded.turns.map((t) => {
    const { user, agent, images, errors } = turnText(t);
    const reply = latestFirstWithin(agent, perTurn);
    return {
      reply,
      data: {
        turn: t.turn,
        position: t.position,
        started_at: toIso(t.startedAt),
        ended_at: toIso(t.endedAt),
        user_text: truncate(user, userMax),
        agent_text: reply.replace(OMITTED, ""),
        omitted_messages: Number(reply.match(OMITTED)?.[1] ?? 0),
        errors,
        ...(images.length ? { images: images.map((i) => imageRef(i, target.cwd)) } : {}),
      },
    };
  });
  const turns = shaped.map((s) => s.data);
  const header = chatHeader(target);
  let text;
  if (turns.length === 1) {
    // The single-turn layout predates batch reads; kept as it was.
    const [t] = turns;
    text = [
      header,
      `Turn ${t.turn} of ${loaded.total}, counted from the latest.`,
      `User asked: ${t.user_text}`,
      shaped[0].reply ? `Agent replied: ${shaped[0].reply}` : "Agent has not replied in this turn yet.",
      ...t.errors.map((e) => `Error: ${e}`),
      ...(t.images ? [imageHint(t.turn, t.images.length)] : []),
    ].join("\n");
  } else {
    text = [
      header,
      `Turns ${turns[turns.length - 1].turn}-${turns[0].turn} of ${loaded.total} counted from the latest, oldest first:`,
      ...turns.flatMap((t) => [
        `- Turn ${t.turn} (${t.started_at ?? "time unknown"}):`,
        `  User: ${t.user_text}`,
        `  Agent: ${t.agent_text || "(no reply yet)"}${t.omitted_messages ? ` (${t.omitted_messages} earlier message(s) omitted)` : ""}`,
        ...t.errors.map((e) => `  Error: ${e}`),
        ...(t.images ? [`  ${imageHint(t.turn, t.images.length)}`] : []),
      ]),
    ].join("\n");
  }
  return { text, data: { chat: chatData(target), total_turns: loaded.total, turns } };
}

function renderTurnsCommands(target, loaded, max) {
  const shownPerTurn = loaded.turns.length === 1 ? COMMANDS_SHOWN : Math.max(3, Math.floor(12 / loaded.turns.length));
  const perTurn = Math.floor(max / loaded.turns.length);
  const turns = loaded.turns.map((t) => {
    const calls = turnText(t).calls;
    const shown = calls.slice(-shownPerTurn);
    const perCall = Math.max(120, Math.floor(perTurn / Math.max(1, shown.length)));
    return {
      turn: t.turn,
      position: t.position,
      started_at: toIso(t.startedAt),
      total_tool_calls: calls.length,
      tool_calls: shown.map((c) => toolCallData(c, perCall)),
    };
  });
  const lines = [chatHeader(target)];
  for (const t of turns) {
    const scope = t.total_tool_calls > t.tool_calls.length ? `the last ${t.tool_calls.length} of ${t.total_tool_calls} tool calls` : `${t.total_tool_calls} tool call(s)`;
    lines.push(
      t.total_tool_calls === 0
        ? `Turn ${t.turn} of ${loaded.total}, counted from the latest: no commands or tool calls.`
        : `Turn ${t.turn} of ${loaded.total}, counted from the latest, ${scope}:\n${truncate(t.tool_calls.map((c) => c.text).join("\n"), perTurn)}`,
    );
  }
  return { text: lines.join("\n"), data: { chat: chatData(target), total_turns: loaded.total, turns } };
}

// The agent's reasoning in each turn, latest kept first when it does not fit. Claude often records
// no thinking text, so an empty turn says so instead of looking like a failed read.
function renderTurnsThinking(target, loaded, max) {
  const perTurn = Math.floor(max / loaded.turns.length);
  const turns = loaded.turns.map((t) => {
    const thoughts = turnText(t).thinking;
    const kept = latestFirstWithin(thoughts, perTurn);
    return {
      turn: t.turn,
      position: t.position,
      started_at: toIso(t.startedAt),
      thinking: kept.replace(OMITTED, ""),
      omitted_thoughts: Number(kept.match(OMITTED)?.[1] ?? 0),
    };
  });
  const lines = [chatHeader(target)];
  for (const t of turns) {
    const where = `Turn ${t.turn} of ${loaded.total}, counted from the latest`;
    lines.push(
      t.thinking
        ? `${where}, the agent's thinking${t.omitted_thoughts ? ` (${t.omitted_thoughts} earlier part(s) omitted)` : ""}:\n${t.thinking}`
        : `${where}: no thinking recorded; the model shared none in this turn.`,
    );
  }
  return { text: lines.join("\n"), data: { chat: chatData(target), total_turns: loaded.total, turns } };
}

const RENDERERS = { text: renderTurnsText, commands: renderTurnsCommands, thinking: renderTurnsThinking };

// Searches one chat's messages; returns matches with turn numbers and snippets.
async function searchChat(client, chat, query, perChat) {
  const found = await client.searchAgentTimeline({ agentId: chat.id, query });
  const locations = found.locations ?? [];
  if (locations.length === 0) return { chat, total: 0, matches: [] };
  const index = await client.listAgentTimelinePrompts(chat.id);
  const prompts = index.prompts ?? [];
  const turnOf = (seq) => prompts.length - prompts.filter((p) => p.seq <= seq).length + 1;
  const matches = await Promise.all(
    locations.slice(0, perChat).map(async (location) => {
      const page = await client.fetchAgentTimeline(chat.id, {
        direction: "after",
        cursor: { epoch: found.epoch, seq: Math.max(0, location.seq - 1) },
        limit: 1,
        projection: "projected",
      });
      const entry = page.entries[0];
      return {
        turn: turnOf(location.seq),
        role: location.role,
        at: toIso(entry?.timestamp),
        snippet: snippet(withoutImages(entry?.item?.text), query),
      };
    }),
  );
  return { chat, total: locations.length, matches };
}

function matchLine(chat, m) {
  return `${truncate(chat.title, 50)} (${chat.project}), turn ${m.turn} (${m.role}): ${m.snippet}`;
}

// A read that took the one active chat among several matches says so before its answer.
function withNote(result, note) {
  if (!note) return result;
  return { text: `${note}\n${result.text}`, data: { ...result.data, note } };
}

export async function readChat(pairingUrl, args = {}) {
  return withDaemon(pairingUrl, (client) => readChatOn(client, args));
}

// read_chat over an open connection (tests drive it with a fake client).
export async function readChatOn(client, { chat, view = "text", turn = 1, turns = 1, maxChars } = {}) {
  const count = clamp(Math.trunc(turns) || 1, 1, MAX_TURNS);
  const from = Math.max(1, Math.trunc(turn) || 1);
  const max = clamp(maxChars ?? (count === 1 ? 1500 : Math.min(6000, 800 * count)), 200, 6000);
  const picked = await pickChat(client, chat, undefined, { read: true });
  if (picked.ask) return picked.ask;
  const target = picked.chat;
  const loaded = await loadTurns(client, target.id, from, count);
  if (loaded.missing) {
    return withNote({ text: `${chatLine(target)}\n${loaded.missing}`, data: { chat: chatData(target), total_turns: loaded.total, turns: [] } }, picked.note);
  }
  return withNote((RENDERERS[view] ?? renderTurnsText)(target, loaded, max), picked.note);
}

// The images in `count` turns of a chat starting at turn `from`, newest first: each with its turn,
// its N in that turn's text and its source.
async function imagesIn(client, chat, from, count) {
  const loaded = await loadTurns(client, chat.id, from, count);
  const images = loaded.turns.flatMap((t) => turnText(t).images.map((image) => ({ ...image, turn: t.turn })));
  return { total: loaded.total, images: images.reverse() };
}

// One turn when asked for; otherwise the latest turns, and further back (deep) when they hold none.
async function findImages(client, chat, { turn, deep }) {
  if (turn) return imagesIn(client, chat, turn, 1);
  const recent = await imagesIn(client, chat, 1, IMAGE_RECENT_TURNS);
  if (!deep || recent.images.length > 0 || recent.total <= IMAGE_RECENT_TURNS) return recent;
  return imagesIn(client, chat, IMAGE_RECENT_TURNS + 1, IMAGE_SCAN_TURNS - IMAGE_RECENT_TURNS);
}

// One image's bytes from the Mac, read through the relay the way Paseo's own client reads the
// pictures in a chat. Only sources found in the chat's timeline get here, never a path from the
// caller. Returns { mime, bytes, data } or { reason }.
async function readImage(client, image, cwd) {
  const target = imageTarget(image.source, cwd);
  if (target.inline) {
    const bytes = Math.floor((target.inline.data.length * 3) / 4);
    return bytes > IMAGE_MAX_BYTES ? { reason: "too_large" } : { mime: target.inline.mime, bytes, data: target.inline.data };
  }
  if (target.link) return { reason: "link" };
  if (!target.file) return { reason: "unsupported" };
  try {
    const file = await client.readFile(target.file.cwd, target.file.path, undefined, IMAGE_MAX_BYTES);
    if (file.kind !== "image") return { reason: "unsupported" };
    return { mime: imageMime(target.file.path), bytes: file.bytes.byteLength, data: Buffer.from(file.bytes).toString("base64") };
  } catch (error) {
    const message = String(error?.message ?? error);
    if (/too large/i.test(message)) return { reason: "too_large" };
    if (/ENOENT|no such file/i.test(message)) return { reason: "missing" };
    if (/outside of workspace/i.test(message)) return { reason: "refused" };
    return { reason: "error" };
  }
}

// show_images over an open connection (tests drive it with a fake client). Picks the chat, finds
// its images, reads the wanted ones within the size budget and returns them three ways: speech in
// `text`, metadata in `data` and the bytes in `meta`, which only the widget sees.
export async function showImagesOn(client, { chat, turn, image, count } = {}) {
  const from = turn || image ? Math.max(1, Math.trunc(turn) || 1) : null;
  let target;
  let note;
  let found;
  if (chat) {
    const picked = await pickChat(client, chat, undefined, { read: true });
    if (picked.ask) return picked.ask;
    target = picked.chat;
    note = picked.note;
    found = await findImages(client, target, { turn: from, deep: true });
  } else {
    // "The latest screenshot": the most recently updated chat with an image in its latest turns.
    const chats = (await fetchChats(client)).slice(0, IMAGE_SCAN_CHATS);
    const scanned = await mapLimit(chats, 4, (c) => findImages(client, c, { turn: from, deep: false }).catch(() => ({ images: [] })));
    const index = scanned.findIndex((s) => s.images.length > 0);
    if (index < 0) {
      return { text: `No images in the latest turns of the ${chats.length} most recent chats.`, data: { total_images: 0, images: [], skipped: [] } };
    }
    target = chats[index];
    found = scanned[index];
  }
  const wanted = Math.trunc(image) || 0;
  const limit = clamp(Math.trunc(count) || (from ? IMAGES_SHOWN : 1), 1, IMAGES_SHOWN);
  let chosen = wanted ? found.images.filter((i) => i.n === wanted) : found.images.slice(0, limit);
  if (wanted && chosen.length === 0 && found.images.length > 0) {
    return {
      text: `Turn ${from} of ${truncate(target.title, 70)} (${target.project}) has ${found.images.length} image(s), so there is no image ${wanted}.`,
      data: { chat: chatData(target), ...(note ? { note } : {}), total_images: found.images.length, images: [], skipped: [] },
    };
  }
  // A whole turn reads in its own order; "the latest images" newest first.
  if (from) chosen = [...chosen].sort((a, b) => a.n - b.n);
  const shown = [];
  const skipped = [];
  let used = 0;
  for (const picked of chosen) {
    const read = await readImage(client, picked, target.cwd);
    const named = { ...picked, name: imageName(picked) };
    if (read.reason) skipped.push({ ...named, reason: read.reason });
    else if (used + read.bytes > IMAGES_MAX_BYTES) skipped.push({ ...named, reason: "too_much_at_once" });
    else {
      used += read.bytes;
      shown.push({ ...named, ...read });
    }
  }
  const text = imagesText({ chat: target, turn: from, found: found.images.length, shown, skipped });
  const data = {
    chat: chatData(target),
    ...(note ? { note } : {}),
    total_images: found.images.length,
    images: shown.map((i) => ({ n: i.n, turn: i.turn, name: i.name, mime: i.mime, bytes: i.bytes })),
    skipped: skipped.map((i) => ({ n: i.n, turn: i.turn, name: i.name, reason: i.reason })),
  };
  const meta = {
    "god-mode/images": {
      chat: { title: target.title, project: target.project },
      images: shown.map((i) => ({ n: i.n, turn: i.turn, name: i.name, mime: i.mime, data: i.data })),
    },
  };
  return { text: note ? `${note}\n${text}` : text, data, ...(shown.length ? { meta } : {}) };
}

export async function showImages(pairingUrl, args = {}) {
  return withDaemon(pairingUrl, (client) => showImagesOn(client, args));
}

// What a chat's agent and its subagents are doing now. `known` saves a second listing when the
// caller already has the subagents.
async function activityOf(client, chat, known) {
  const [subagents, prompts, tail] = await Promise.all([
    known ?? listSubagents(client, chat.id),
    client.listAgentTimelinePrompts(chat.id).then((r) => r.prompts ?? []).catch(() => []),
    isRunning(chat) ? client.fetchAgentTimeline(chat.id, { direction: "tail", limit: 40, projection: "projected" }).catch(() => null) : null,
  ]);
  const turnStart = prompts.at(-1);
  const startedAt = Date.parse(turnStart?.timestamp ?? "") || 0;
  const shown = [
    ...subagents.filter((s) => s.status === "running"),
    ...subagents.filter((s) => s.status !== "running" && Date.parse(s.createdAt) >= startedAt),
  ].slice(0, SUBAGENTS_SHOWN);
  const detailed = new Map(
    await Promise.all(
      shown.map(async (s) => {
        try {
          const page = await client.fetchProviderSubagentTimeline(chat.id, s.id, { direction: "tail", limit: SUBAGENT_TAIL });
          const items = page.rows.map((r) => r.item).reverse();
          const step = items.find(isStep);
          const result = items.find((i) => i.type === "assistant_message")?.text;
          return [s.id, { ...s, step: describeStep(step), result: result ? truncate(withoutImages(result), 300) : null }];
        } catch {
          return [s.id, s];
        }
      }),
    ),
  );
  const own = (tail?.entries ?? [])
    .filter((e) => !turnStart || e.seqStart >= turnStart.seq)
    .map((e) => e.item)
    .reverse()
    .find(isStep);
  return activityData({
    chat,
    subagents: subagents.map((s) => detailed.get(s.id) ?? s),
    turnStartedAt: turnStart?.timestamp ?? null,
    parentStep: describeStep(own),
    limit: SUBAGENTS_SHOWN,
  });
}

// read_activity: one chat, or every chat where an agent or a subagent is working now. A turn can
// end while backgrounded subagents keep going, so recent idle chats are asked too.
export async function readActivity(pairingUrl, args = {}) {
  return withDaemon(pairingUrl, (client) => readActivityOn(client, args));
}

// read_activity over an open connection (tests drive it with a fake client).
export async function readActivityOn(client, { chat, maxChars } = {}) {
  const max = clamp(maxChars ?? 1500, 200, 6000);
  const chats = await fetchChats(client);
  if (chat) {
    const picked = await pickChat(client, chat, chats, { read: true });
    if (picked.ask) return picked.ask;
    const activity = await activityOf(client, picked.chat);
    const summary = activity.working ? "working" : "not working";
    return withNote({ text: truncate(activityText(activity), max), data: { summary, chats: [activity] } }, picked.note);
  }
  const now = Date.now();
  const candidates = chats.filter((c) => isRunning(c) || now - Date.parse(c.updatedAt) < ACTIVITY_RECENT_MS).slice(0, ACTIVITY_SCAN);
  await countSubagents(client, candidates);
  const working = candidates.filter((c) => isRunning(c) || c.subagentsRunning > 0);
  if (working.length === 0) {
    return { text: "No agent or subagent is working right now.", data: { summary: "Nothing is working right now.", chats: [] } };
  }
  const activities = await Promise.all(working.map((c) => activityOf(client, c, c.subagents)));
  const helpers = activities.reduce((n, a) => n + a.subagents_running, 0);
  const summary = `${activities.length} chat(s) working, ${helpers} subagent(s) running.`;
  return { text: truncate([summary, ...activities.map(activityText)].join("\n"), max), data: { summary, chats: activities } };
}

// Finds where something was said, across many chats at once: Paseo searches
// one chat at a time, so the chats are searched here in parallel.
export async function searchMessages(pairingUrl, args = {}) {
  return withDaemon(pairingUrl, (client) => searchMessagesOn(client, args));
}

// search_messages over an open connection (tests drive it with a fake client).
export async function searchMessagesOn(client, { query, project, chat, includeArchived = false, scan, limit = 10 } = {}) {
  const wanted = clamp(Math.trunc(limit) || 10, 1, 30);
  let candidates;
  let note;
  if (chat) {
    const picked = await pickChat(client, chat, undefined, { read: true });
    if (picked.ask) return picked.ask;
    candidates = [picked.chat];
    note = picked.note;
  } else {
    candidates = includeArchived
      ? await fetchChatHistory(client, { includeArchived: true, limit: CHAT_PAGE })
      : await fetchChats(client);
    if (project) {
      const picked = pickProject(await fetchProjects(client), project);
      if (picked.ask) return picked.ask;
      candidates = candidates.filter((c) => c.project === picked.project.name);
    }
    candidates = candidates.slice(0, clamp(Math.trunc(scan) || SEARCH_SCAN.default, 1, SEARCH_SCAN.max));
  }
  const perChat = chat ? Math.min(wanted, 8) : 2;
  const results = await mapLimit(candidates, SEARCH_CONCURRENCY, (c) =>
    searchChat(client, c, query, perChat).catch(() => ({ chat: c, total: 0, matches: [] })),
  );
  const hits = results.filter((r) => r.total > 0);
  const matches = hits.flatMap((r) => r.matches.map((m) => ({ chat: r.chat, ...m }))).slice(0, wanted);
  const data = {
    query,
    searched_chats: candidates.length,
    matched_chats: hits.length,
    total_matches: 0,
    matches: matches.map(({ chat: c, ...m }) => ({
      chat: { id: c.id, short_id: c.id.slice(0, 7), title: c.title, project: c.project, updated_at: toIso(c.updatedAt), archived: c.archived },
      ...m,
    })),
  };
  if (matches.length === 0) {
    return withNote({ text: `No messages matching "${query}" in the ${candidates.length} most recent chat(s) searched.`, data }, note);
  }
  const totalMatches = hits.reduce((n, r) => n + r.total, 0);
  data.total_matches = totalMatches;
  const shown = matches.length < totalMatches ? `; ${matches.length} of ${totalMatches} matches shown` : "";
  return withNote(
    {
      text: [`"${query}" found in ${hits.length} of ${candidates.length} chat(s) searched${shown}:`, ...matches.map((m) => matchLine(m.chat, m))].join("\n"),
      data,
    },
    note,
  );
}

// Waits up to `seconds` for the agent's turn to end and describes the outcome.
async function awaitReply(client, agentId, seconds) {
  const wait = clamp(seconds, 0, MAX_WAIT_SECONDS);
  if (wait === 0) return { text: "Not waiting for the reply; offer to check later.", data: { outcome: "not_waiting", delivered: true } };
  const state = await client.waitForFinish(agentId, wait * 1000);
  switch (state.status) {
    case "idle":
      return repliedOutcome(state.lastMessage);
    case "permission": {
      const pending = state.final?.pendingPermissions?.[0];
      const approval = pending ? describePermission(pending) : "a tool call";
      return { text: `Agent is waiting for approval: ${approval}.`, data: { outcome: "waiting_for_approval", delivered: true, approval } };
    }
    case "error": {
      const error = truncate(state.error ?? "unknown", 300);
      return { text: `Agent stopped with an error: ${error}`, data: { outcome: "error", delivered: true, error } };
    }
    default:
      return { text: "Agent is still working. Tell the user and offer to check later; do not poll.", data: { outcome: "still_working", delivered: true } };
  }
}

export async function startChat(pairingUrl, args = {}) {
  return withDaemon(pairingUrl, (client) => startChatOn(client, args));
}

// start_chat over an open connection (tests drive it with a fake client). The runtime, model,
// thinking level and mode are checked against Paseo's catalog first (see Models below); `defaults`
// are the site's settings for new chats, used where they fit the runtime the chat gets. Without
// `workspace` the chat gets a workspace of its own, as Paseo's New chat does; with one it opens in that
// workspace as another tab, in its folder, and Paseo keeps the workspace's name.
export async function startChatOn(client, { project, workspace, prompt, provider, model, thinking, mode, defaults = {}, waitSeconds = 15 } = {}) {
  let place;
  if (workspace) {
    const picked = await pickWorkspace(client, workspace, project);
    if (picked.ask) return picked.ask;
    ({ place } = picked);
  } else {
    const picked = pickProject(await fetchProjects(client), project);
    if (picked.ask) return picked.ask;
    place = { name: picked.project.name, directory: picked.project.directory };
  }
  const chosen = chooseStart(await fetchCatalog(client, place.directory), { provider, model, thinking, mode }, defaults);
  if (chosen.ask) return chosen.ask;
  const { choice } = chosen;
  const agent = await client.createAgent({
    provider: choice.provider.id,
    cwd: place.directory,
    ...(place.workspaceId ? { workspaceId: place.workspaceId } : {}),
    initialPrompt: prompt,
    ...(choice.model ? { model: choice.model.id } : {}),
    ...(choice.thinking ? { thinkingOptionId: choice.thinking } : {}),
    ...(choice.mode ? { modeId: choice.mode } : {}),
    labels: { source: "god-mode" },
  });
  const runtime = runtimeOf(choice, agent);
  const outcome = await awaitReply(client, agent.id, waitSeconds);
  const where = place.workspaceId ? `${place.name}, in its workspace "${truncate(place.workspace, 70)}"` : place.name;
  const workspaceId = agent.workspaceId ?? place.workspaceId;
  return {
    text: `Started a new chat in ${where} (${runtime.text}); the task arrived. Do not start it again.\n${outcome.text}`,
    data: {
      chat_id: agent.id,
      short_id: agent.id.slice(0, 7),
      project: place.name,
      ...(workspaceId ? { workspace_id: workspaceId } : {}),
      new_workspace: !place.workspaceId,
      ...runtime.data,
      ...outcome.data,
    },
  };
}

export async function sendMessage(pairingUrl, args = {}) {
  return withDaemon(pairingUrl, (client) => sendMessageOn(client, args));
}

// send_message over an open connection (tests drive it with a fake client).
export async function sendMessageOn(client, { chat, text, ifBusy, ifArchived, waitSeconds = 15 } = {}) {
  const chats = await fetchChats(client);
  const picked = await pickChat(client, chat, chats);
  if (picked.ask) return picked.ask;
  const target = picked.chat;
  const title = truncate(target.title, 70);
  const ids = { chat_id: target.id, short_id: target.id.slice(0, 7), project: target.project };
  // Only an id reaches an archived chat, and a message brings it back. An active chat with its
  // title is most likely its continuation, and the id one kept from before the move.
  const namesakes = target.archived ? chats.filter((c) => normalize(c.title) === normalize(target.title)).slice(0, 5) : [];
  if (namesakes.length && ifArchived !== "restore") {
    return {
      text: [
        `Not sent: ${title} is archived, and ${namesakes.length === 1 ? "an active chat has" : `${namesakes.length} active chats have`} its title, most likely its continuation:`,
        ...namesakes.map((c) => `- ${choiceLine(c)}`),
        'Ask the user which chat they mean and send it there by its id. Only if they want the archived one back with this message, call again with if_archived "restore".',
      ].join("\n"),
      data: { ...ids, outcome: "archived", delivered: false, same_title: namesakes.map((c) => chatData(c)) },
    };
  }
  const busy = isRunning(target);
  if (busy && !ifBusy) {
    return {
      text: `Not sent: ${title} is busy. Ask the user whether to add this to its current work or interrupt it, then call again with if_busy.`,
      data: { ...ids, outcome: "busy", delivered: false },
    };
  }
  await client.sendAgentMessage(target.id, text, busy ? { activeTurnBehavior: ifBusy } : undefined);
  const outcome = await awaitReply(client, target.id, waitSeconds);
  const back = target.archived ? " It was archived; the message brought it back." : "";
  return {
    text: `Sent to ${title}; it arrived.${back} Do not send it again.\n${outcome.text}`,
    data: { ...ids, ...outcome.data },
  };
}

export async function answerApproval(pairingUrl, args = {}) {
  return withDaemon(pairingUrl, (client) => answerApprovalOn(client, args));
}

// answer_approval over an open connection (tests drive it with a fake client).
export async function answerApprovalOn(client, { chat, decision, request } = {}) {
  const picked = await pickChat(client, chat);
  if (picked.ask) return picked.ask;
  const target = picked.chat;
  const pending = target.permissions;
  if (pending.length === 0) {
    return {
      text: `${chatLine(target)}\nNothing is waiting for approval here, so nothing was allowed or denied. If the agent asked the user a question in its text, answer it with send_message.`,
      data: { chat_id: target.id, done: false, what: null },
    };
  }
  let permission = pending[0];
  if (pending.length > 1) {
    const byNumber = pending[Number(request) - 1];
    const byText = request ? resolve(pending, request, { text: (p) => describePermission(p) }).match : null;
    permission = byNumber ?? byText;
    if (!permission) {
      const options = pending.map((p) => describePermission(p, 100));
      return clarification(
        "approval",
        request,
        [chatLine(target), "Several requests are waiting. Ask the user which one, then call again with request set to its number:", ...options.map((o, i) => `${i + 1}. ${o}`)].join("\n"),
        options,
      );
    }
  }
  const behavior = decision === "allow" ? "allow" : "deny";
  // Questions take answers (answer_questions); denying dismisses them, as Paseo's own Dismiss does.
  if (permission.kind === "question" && behavior === "allow") return questionsNeedAnswers(target, permission);
  const what = describePermission(permission);
  // Press the same button the app would show ("Implement", "Reject", …).
  const action = permission.actions?.find((a) => a.behavior === behavior);
  const response = {
    behavior,
    ...(action ? { selectedActionId: action.id } : {}),
    ...(behavior === "deny" ? { message: "Denied by voice." } : {}),
  };
  await client.respondToPermissionAndWait(target.id, permission.id, response, 10_000);
  return {
    text: `${behavior === "allow" ? "Allowed" : "Denied"}: ${what} in ${truncate(target.title, 70)}.`,
    data: { chat_id: target.id, done: true, kind: permission.kind, decision: behavior, what },
  };
}

// ---- Questions ----------------------------------------------------------------------------------
// read_approval and answer_questions. A question request (questions.mjs) is answered with the
// options the user chose, sent as Paseo's own form sends them: allow, with the request's input and
// its answers keyed by header.

export async function readApproval(pairingUrl, args = {}) {
  return withDaemon(pairingUrl, (client) => readApprovalOn(client, args));
}

// read_approval over an open connection (tests drive it with a fake client): every request the chat
// waits on, questions and options in full.
export async function readApprovalOn(client, { chat } = {}) {
  const picked = await pickChat(client, chat, undefined, { read: true });
  if (picked.ask) return picked.ask;
  return withNote(approvalResult(picked.chat), picked.note);
}

export async function answerQuestions(pairingUrl, args = {}) {
  return withDaemon(pairingUrl, (client) => answerQuestionsOn(client, args));
}

// answer_questions over an open connection (tests drive it with a fake client). Nothing is sent
// unless the request is still the one read_approval gave and the answers fill its every question.
export async function answerQuestionsOn(client, { chat, request, answers, waitSeconds = 15 } = {}) {
  const picked = await pickChat(client, chat);
  if (picked.ask) return picked.ask;
  const prepared = prepareAnswers(picked.chat, request, answers);
  if (prepared.refused) return prepared.refused;
  await client.respondToPermissionAndWait(picked.chat.id, prepared.permission.id, answerResponse(prepared.permission, prepared.filled), 10_000);
  return answeredResult(picked.chat, request, prepared.filled, await awaitReply(client, picked.chat.id, waitSeconds));
}

export async function stopChat(pairingUrl, args = {}) {
  return withDaemon(pairingUrl, (client) => stopChatOn(client, args));
}

// stop_chat over an open connection (tests drive it with a fake client).
export async function stopChatOn(client, { chat } = {}) {
  const picked = await pickChat(client, chat);
  if (picked.ask) return picked.ask;
  const target = picked.chat;
  if (!isRunning(target)) {
    return { text: `${chatLine(target)}\nIt is not running; nothing was stopped.`, data: { chat_id: target.id, done: false } };
  }
  await client.cancelAgent(target.id);
  return {
    text: `Stopped ${truncate(target.title, 70)}. State before: ${chatState(target)}.`,
    data: { chat_id: target.id, done: true },
  };
}

// Archives a chat the way Paseo's Archive does: hidden from the list, history kept, and a new message
// brings it back. Paseo would interrupt a working agent and its subagents, so a busy chat is left
// alone and the user decides.
export async function archiveChat(pairingUrl, { chat } = {}) {
  return withDaemon(pairingUrl, (client) => archiveChatOn(client, { chat }));
}

// archive_chat over an open connection (tests drive it with a fake client).
export async function archiveChatOn(client, { chat } = {}) {
  const picked = await pickChat(client, chat);
  if (picked.ask) return picked.ask;
  const target = picked.chat;
  const ids = { chat_id: target.id, short_id: target.id.slice(0, 7) };
  if (target.archived) {
    return { text: `${chatLine(target)}\nIt is already archived; nothing changed.`, data: { ...ids, outcome: "already_archived", done: false } };
  }
  const helpers = (await listSubagents(client, target.id)).filter((s) => s.status === "running").length;
  if (isRunning(target) || helpers > 0) {
    const what = isRunning(target) ? "its agent is working" : `${helpers} subagent(s) are working`;
    return {
      text: `Not archived: ${truncate(target.title, 70)} is busy, ${what}, and archiving would interrupt it. Tell the user; it can be archived once it is done, or after stop_chat if they want it stopped.`,
      data: { ...ids, outcome: "busy", done: false },
    };
  }
  const { archivedAt } = await client.archiveAgent(target.id);
  return {
    text: `Archived ${truncate(target.title, 70)}. Its history is kept; a new message to it brings it back.`,
    data: { ...ids, outcome: "archived", done: true, archived_at: toIso(archivedAt) },
  };
}

export async function pinChat(pairingUrl, args = {}) {
  return withDaemon(pairingUrl, (client) => pinChatOn(client, args));
}

// pin_chat over an open connection (tests drive it with a fake client). Paseo pins a sidebar row, a
// workspace, as its own Pin and Unpin do: a chat is pinned through its row, and a row with no chat
// is reached by its name or its workspace id. A pin already as asked is left alone, since pinning
// again would move the row to the top of Pinned.
export async function pinChatOn(client, { chat, workspaceId, action } = {}) {
  const [workspaces, chats] = await Promise.all([fetchAllWorkspaces(client), fetchChats(client)]);
  const rows = workspaces.map((w) => toRow(w, chats));
  let target = null;
  let row;
  if (workspaceId) {
    row = rows.find((r) => r.id === workspaceId);
    if (!row) return rowQuestion(workspaceId);
  } else {
    const picked = await pickChat(client, chat, chats);
    if (picked.ask) {
      row = pinRowFor(rows, chats, chat, picked.ask.data.needs_clarification.reason);
      if (!row) return picked.ask;
    } else {
      target = picked.chat;
      if (target.archived) return pinResult({ action, outcome: "archived", chat: target });
      row = rows.find((r) => r.id === target.workspaceId);
      if (!row) return pinResult({ action, outcome: "no_row", chat: target });
    }
  }
  const pin = action === "pin";
  if (pin === Boolean(row.pinnedAt)) return pinResult({ action, outcome: pin ? "already_pinned" : "not_pinned", row, chat: target });
  const { pinnedAt } = await client.setWorkspacePinned(row.id, pin);
  return pinResult({ action, outcome: pin ? "pinned" : "unpinned", row: { ...row, pinnedAt }, chat: target });
}

// ---- Models -------------------------------------------------------------------------------------
// list_models, and the check start_chat makes before a chat starts. Paseo checks only the mode when
// it creates an agent: a model or thinking level its provider lacks gives a chat that fails on its
// first turn. models.mjs matches what the user said against this catalog.

// Paseo's catalog for a directory (it can differ per project), as its New chat shows it: every
// enabled provider with its models and modes. Listing waits for a provider Paseo is still loading.
async function fetchCatalog(client, cwd) {
  const scope = cwd ? { cwd } : {};
  const { entries } = await client.getProvidersSnapshot(scope);
  return Promise.all(
    entries
      .filter((entry) => entry.enabled !== false)
      .map(async (entry) => {
        if (!["ready", "loading"].includes(entry.status)) return catalogEntry(entry);
        const [models, modes] = await Promise.all([client.listProviderModels(entry.provider, scope), client.listProviderModes(entry.provider, scope)]);
        return catalogEntry(entry, models, modes);
      }),
  );
}

export async function listModels(pairingUrl, args = {}) {
  return withDaemon(pairingUrl, (client) => listModelsOn(client, args));
}

// list_models over an open connection (tests drive it with a fake client).
export async function listModelsOn(client, { provider } = {}) {
  const catalog = await fetchCatalog(client);
  let shown = catalog;
  if (provider) {
    const picked = pickProvider(catalog, provider);
    if (picked.ask) return picked.ask;
    shown = [picked.provider];
  }
  return { text: modelsText(shown), data: { providers: modelsData(shown) } };
}

export async function setChatModel(pairingUrl, args = {}) {
  return withDaemon(pairingUrl, (client) => setChatModelOn(client, args));
}

// The model and thinking level a chat runs on, as Paseo reports them.
const runningOn = (chat) => ({ model: chat.model, thinking: chat.thinking });

// Whether Paseo reports the change, or part of it, on the chat.
function reflects(now, { model, thinking }) {
  return {
    model: Boolean(model && (now.model === model.id || model.aliases?.includes(now.model))),
    thinking: thinking !== undefined && (now.thinking ?? null) === thinking,
  };
}

// set_chat_model over an open connection (tests drive it with a fake client). The chat keeps its history
// and its runtime: Paseo changes the model and thinking level of the live chat with its own request for
// it, in one request (the model first, since a level means something only against the model that offers
// it). A working chat is changed too; Paseo applies the level from its next turn. What is asked is
// checked against Paseo's catalog first, because Paseo's setters take any string, and what the chat
// runs on afterwards is read back from Paseo.
export async function setChatModelOn(client, { chat, model, thinking } = {}) {
  const picked = await pickChat(client, chat);
  if (picked.ask) return picked.ask;
  const target = picked.chat;
  const before = runningOn(target);
  const result = (outcome, fields = {}) => changeResult({ outcome, chat: target, before, ...fields });
  if (target.archived) return result("archived");
  if (!CHANGEABLE.includes(target.provider)) {
    return result("unavailable", { error: `God Mode changes the model and thinking level only of Claude and Codex chats, and this one runs on ${target.provider ?? "an unknown runtime"}. The user can change it in Paseo on the computer.` });
  }
  const catalog = await fetchCatalog(client, target.cwd);
  const runtime = catalog.find((p) => p.id === target.provider);
  if (!runtime?.available) {
    return result("unavailable", { provider: runtime ?? null, error: `Paseo cannot list ${target.provider} models now (${truncate(runtime?.error ?? "not set up", 150)}).` });
  }
  const chosen = chooseChange(catalog, { provider: target.provider, ...before }, { model, thinking });
  if (chosen.ask) return chosen.ask;
  if (chosen.other) return result("other_runtime", { provider: runtime, other: chosen.other });
  const { change } = chosen;
  if (!change.model && change.thinking === undefined) return result("unchanged", { provider: runtime });
  const busy = isRunning(target) || isWaiting(target);
  let notice = null;
  let failure = null;
  try {
    notice = (await client.applyAgentConfig(target.id, {
      ...(change.model ? { modelId: change.model.id } : {}),
      ...(change.thinking !== undefined ? { thinkingOptionId: change.thinking } : {}),
    }))?.message ?? null;
  } catch (error) {
    failure = `Paseo refused it: ${truncate(error?.message ?? error, 200)}`;
  }
  let after = null;
  try {
    const fetched = await client.fetchAgent(target.id);
    if (fetched) after = runningOn(toChat(fetched));
  } catch {
    // The answer then says it could not look.
  }
  if (!after) {
    // Nothing read back: after a failure it is unknown what was applied, after success the request stands.
    if (failure) return result("error", { provider: runtime, error: `${failure}; it could not be read back, so it is unknown whether part of it applied` });
    after = { model: change.model?.id ?? before.model, thinking: change.thinking === undefined ? before.thinking : change.thinking };
  }
  const reflected = reflects(after, change);
  const complete = (!change.model || reflected.model) && (change.thinking === undefined || reflected.thinking);
  if (failure || !complete) {
    const outcome = reflected.model || reflected.thinking ? "partial" : "error";
    return result(outcome, { provider: runtime, after, error: failure ?? "Paseo accepted it but still reports part of the old settings on the chat" });
  }
  return result("changed", { provider: runtime, after, change, busy, notice });
}

// ---- Slash commands -----------------------------------------------------------------------------
// list_slash_commands and run_slash_command. Which commands each provider runs, and how, is in
// slash.mjs; this part asks Paseo for a chat's commands, sends one as the message its provider
// interprets, and reads back what that message did.

const COMMAND_ENTRIES = 200;
const COMMAND_POLL_MS = 1_000;

const pause = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

// The chat's commands with God Mode's verdict on each, or { error } when Paseo could not list them
// (an agent that cannot start, a provider that is not installed).
async function chatCommands(client, chat) {
  const payload = await client.listCommands({ agentId: chat.id });
  if (payload?.error) return { error: String(payload.error) };
  return { catalog: describeCommands(chat.provider, payload?.commands ?? []) };
}

export async function listSlashCommands(pairingUrl, args = {}) {
  return withDaemon(pairingUrl, (client) => listSlashCommandsOn(client, args));
}

// list_slash_commands over an open connection (tests drive it with a fake client). Listing starts
// the chat's agent when Paseo has not yet (after a restart of Paseo), as Paseo's own command menu does.
export async function listSlashCommandsOn(client, { chat, query, limit = 60 } = {}) {
  const picked = await pickChat(client, chat, undefined, { read: true });
  if (picked.ask) return picked.ask;
  const target = picked.chat;
  const base = { chat: chatData(target), provider: target.provider ?? "unknown", runtime: adapterFor(target.provider).label };
  const empty = { total: 0, shown: 0, commands: [] };
  if (target.archived) {
    return withNote({ text: `${chatLine(target)}\nIt is archived, and Paseo lists the commands of active chats only. A new message to it brings it back.`, data: { ...base, ...empty } }, picked.note);
  }
  const listed = await chatCommands(client, target);
  if (listed.error) {
    const error = truncate(listed.error, 300);
    return withNote({ text: `${chatLine(target)}\nPaseo could not list its commands: ${error}`, data: { ...base, ...empty, error } }, picked.note);
  }
  const { catalog } = listed;
  const words = String(query ?? "").trim();
  const matching = words ? filterCommands(catalog, words) : catalog.entries;
  const shown = matching.slice(0, clamp(Math.trunc(limit) || 60, 1, 100));
  const text = listText({ chatLine: chatLine(target), catalog, shown, total: matching.length, query: words, mode: target.mode });
  return withNote(
    {
      text: shown.length < matching.length ? `${text}\n${matching.length - shown.length} more not shown; narrow it with a query.` : text,
      data: {
        ...base,
        runs_commands: catalog.runs,
        ...(catalog.reason ? { reason: catalog.reason } : {}),
        total: matching.length,
        runs_at_once: matching.filter((e) => e.available && !e.asks_first).length,
        asks_first: matching.filter((e) => e.available && e.asks_first).length,
        unavailable: matching.filter((e) => !e.available).length,
        shown: shown.length,
        commands: shown.map(commandData),
      },
    },
    picked.note,
  );
}

export async function runSlashCommand(pairingUrl, args = {}) {
  // The pairing link is the Site's one secret, so confirmations are signed with it.
  return withDaemon(pairingUrl, (client) => runSlashCommandOn(client, { ...args, secret: pairingUrl }));
}

// What the timeline gained after the command God Mode sent, read against the chat's state now.
// The command's own message is found by its client message id; until it shows up, nothing is known.
async function readCommandResult(client, target, entry, cursor, messageId) {
  const page = await client.fetchAgentTimeline(target.id, { direction: "after", cursor, limit: COMMAND_ENTRIES, projection: "projected" }).catch(() => null);
  let items = page ? afterCommand(page.entries.map((e) => e.item), messageId) : null;
  if (!items) {
    // A timeline Paseo rebuilt (a new epoch) answers the old cursor with nothing: look at the latest.
    const tail = await client.fetchAgentTimeline(target.id, { direction: "tail", limit: COMMAND_ENTRIES, projection: "projected" });
    items = afterCommand(tail.entries.map((e) => e.item), messageId);
  }
  if (!items) return { outcome: "still_working", settled: false };
  const fetched = await client.fetchAgent(target.id);
  const now = fetched ? toChat(fetched) : null;
  const pending = now?.permissions?.[0];
  return commandResult(entry, {
    items,
    status: now?.status ?? null,
    usageBefore: target.usage,
    usageAfter: now?.usage ?? null,
    approval: pending ? describePermission(pending) : null,
  });
}

function commandQuestion(target, catalog, query, candidates) {
  if (candidates.length) {
    return clarification("command", query, candidatesText("command", query, candidates.map((e) => `${e.usage}: ${truncate(e.effect, 100)}`)), candidates.map((e) => e.name));
  }
  const runnable = catalog.entries.filter((e) => e.available).map((e) => e.name);
  return clarification(
    "command",
    query,
    `No command of ${truncate(target.title, 70)} matches "${query}", so nothing was sent. ${runnable.length ? `Its commands: ${runnable.join(", ")}.` : "It offers none God Mode can run."} Ask the user which one they mean.`,
    [],
  );
}

// The answer to a command that reached the chat: what it did, as far as the wait allowed.
function commandAnswer(title, text, entry, result, sent) {
  const once = "It ran once; never run it again for this request.";
  switch (result.outcome) {
    case "done": {
      const change = contextChange(result.context);
      return { text: `Ran ${text} in ${title}: the context was compacted${change ? ` (${change})` : ""}. ${once}`, data: { ...sent, outcome: "done", context: result.context } };
    }
    case "refused":
      return { text: `${text} reached ${title} but did not run: ${result.reason} Nothing changed.`, data: { ...sent, outcome: "refused", reason: result.reason } };
    case "replied": {
      if (!result.reply) return { text: `Ran ${text} in ${title}; it finished without output. ${once}`, data: { ...sent, outcome: "replied", reply: "" } };
      const { text: shown, images } = withImagePlaceholders(result.reply);
      const reply = truncate(shown, 1500);
      const extra = images.length ? `\nThe result has ${images.length} image(s); show_images puts them on the user's screen.` : "";
      return { text: `Ran ${text} in ${title}. ${once} Result:\n${reply}${extra}`, data: { ...sent, outcome: "replied", reply, ...(images.length ? { images: images.length } : {}) } };
    }
    case "waiting_for_approval":
      return { text: `Sent ${text} to ${title}; it arrived and is waiting for approval: ${result.approval}. ${once}`, data: { ...sent, outcome: "waiting_for_approval", approval: result.approval } };
    case "error":
      return { text: `Sent ${text} to ${title}; it arrived and ended with an error: ${result.error}`, data: { ...sent, outcome: "error", error: result.error } };
    default: {
      const doing = entry.compaction ? " (compacting the context)" : "";
      return { text: `Sent ${text} to ${title}; it arrived and is still running${doing}. ${once} Offer to check later with read_chat; do not poll.`, data: { ...sent, outcome: "still_working" } };
    }
  }
}

// run_slash_command over an open connection (tests drive it with a fake client): the chat's own
// list decides what exists, the adapter what may run and how, the confirmation what the user agreed
// to; then one message, and what it did.
export async function runSlashCommandOn(client, { chat, command, args, ifBusy, confirmation, waitSeconds = 15, secret, now = Date.now(), pollMs = COMMAND_POLL_MS } = {}) {
  const picked = await pickChat(client, chat);
  if (picked.ask) return picked.ask;
  const target = picked.chat;
  const title = truncate(target.title, 70);
  const ids = { chat_id: target.id, short_id: target.id.slice(0, 7), project: target.project, provider: target.provider ?? "unknown" };
  const notRun = (reason, extra = {}) => ({ text: `Not run: ${reason} Nothing was sent.`, data: { ...ids, ...extra, outcome: "unavailable", delivered: false, reason } });
  if (target.archived) return notRun(`${title} is archived; a new message to it brings it back first.`);
  const adapter = adapterFor(target.provider);
  if (!adapter.runs) return notRun(adapter.reason);
  const split = splitCommand(command, args);
  if (split.invalid) return { invalid: split.invalid };
  const listed = await chatCommands(client, target);
  if (listed.error) return notRun(`Paseo could not list this chat's commands: ${truncate(listed.error, 200)}`);
  const found = findCommand(listed.catalog, split.name);
  if (!found.match) return commandQuestion(target, listed.catalog, split.name, found.candidates);
  const entry = found.match;
  if (!entry.available) return notRun(`/${entry.name} cannot run in ${title} from here. ${entry.reason}`, { command: `/${entry.name}` });
  const prepared = prepareCommandArgs(entry, split.args);
  if (prepared.invalid) return { invalid: prepared.invalid };
  const text = commandText(entry, prepared.args);
  const base = { ...ids, command: text };

  // A command sent to a working chat replaces its turn (Paseo does so even for steer), so it waits
  // for the user's word; Codex's /goal runs beside the turn and need not.
  const working = isRunning(target) || target.permissions.length > 0;
  const alongside = entry.when_busy === "alongside";
  if (working && !alongside && ifBusy !== "interrupt") {
    const what = target.permissions.length ? "waiting for an approval" : "working";
    return {
      text: `Not sent: ${title} is ${what}, and ${text} would stop that work. Ask the user whether to interrupt it; only on their explicit yes call again with if_busy interrupt.`,
      data: { ...base, outcome: "busy", delivered: false },
    };
  }
  const interrupting = working && !alongside;

  const risk = runRisk(entry, prepared.args);
  if (risk.asksFirst) {
    const subject = { tool: "run_slash_command", chat: target.id, command: text, interrupt: interrupting };
    const verdict = confirmation ? await checkConfirmation(secret, confirmation, subject, now) : "none";
    if (verdict !== "ok") {
      const { token, expiresAt } = await issueConfirmation(secret, subject, now);
      const say = confirmText(entry, { chatTitle: target.title, label: adapter.label, args: prepared.args, notes: risk.notes, interrupting, mode: target.mode });
      const why = { expired: "That confirmation expired. ", mismatch: "That confirmation was for something else. " }[verdict] ?? "";
      return {
        text: `${why}Not run yet: ${text} asks first. Tell the user: "${say}" Only after they say yes, call run_slash_command again with the same chat, command and args plus this confirmation.`,
        data: { ...base, outcome: "needs_confirmation", delivered: false, risk: risk.risk, confirm_text: say, confirmation: token, expires_at: expiresAt },
      };
    }
  }

  const tail = await client.fetchAgentTimeline(target.id, { direction: "tail", limit: 1, projection: "projected" });
  const cursor = { epoch: tail.epoch, seq: tail.entries.at(-1)?.seqStart ?? 0 };
  const messageId = crypto.randomUUID();
  await client.sendAgentMessage(target.id, text, { messageId, ...(interrupting ? { activeTurnBehavior: "interrupt" } : {}) });
  const sent = { ...base, delivered: true, risk: risk.risk };
  const wait = clamp(waitSeconds, 0, MAX_WAIT_SECONDS);
  if (wait === 0) {
    return { text: `Sent ${text} to ${title}; it arrived. It ran once; never run it again for this request. Not waiting for the result; offer to check later.`, data: { ...sent, outcome: "not_waiting" } };
  }
  const deadline = Date.now() + wait * 1000;
  let result = null;
  if (!entry.outOfBand) {
    // A turn of its own: wait for it to end. A command Paseo runs outside any turn (Codex's
    // /compact and /goal) has no turn to wait for, so its result is polled from the timeline.
    await client.waitForFinish(target.id, wait * 1000);
    result = await readCommandResult(client, target, entry, cursor, messageId);
  }
  while (!result?.settled && Date.now() + pollMs < deadline) {
    if (result) await pause(pollMs);
    result = await readCommandResult(client, target, entry, cursor, messageId);
  }
  return commandAnswer(title, text, entry, result ?? { outcome: "still_working" }, sent);
}

// The God Mode plugin in Paseo runs updates and rollbacks of this Site on the Mac; these two reach
// it through the same relay connection as every other tool.
const GOD_MODE = "god-mode";

export async function releaseStatus(pairingUrl, { siteVersion, build = null }) {
  let status = null;
  try {
    status = await withDaemon(pairingUrl, (client) => client.invokePluginRpc(GOD_MODE, "god-mode.release.status", { log: false }));
  } catch (error) {
    // Offline still has an answer: the version this Site is running.
    if (!(error instanceof PaseoOffline)) throw error;
  }
  const data = releaseData(status, siteVersion, build);
  return { text: describeRelease(data), data };
}

export async function releaseStart(pairingUrl, { action }) {
  return withDaemon(pairingUrl, async (client) => {
    const what = action === "rollback" ? "rollback" : "update";
    try {
      const { job } = await client.invokePluginRpc(GOD_MODE, "god-mode.release.start", { action });
      return {
        text: `Started the ${what} on the Mac. It takes a few minutes and puts the previous version back by itself if the new one fails its check; ask for the update status any time.`,
        data: { started: true, action, job_id: job.id, message: `${what} started` },
      };
    } catch (error) {
      const message = String(error?.message ?? error);
      if (/already running/i.test(message)) return { text: `Nothing started: ${message}`, data: { started: false, action, job_id: null, message } };
      throw error;
    }
  });
}

// ---- Plugins that describe themselves (meta.describe) ----------------------------------------
// Every running plugin is asked for its paseo.capabilities/1 description; the ones that answer are
// what plugin_read and plugin_action offer, and nothing here knows a plugin by name. No cache: the
// list and the descriptions add about 0.3 s to the relay connection, and a plugin updated a minute
// ago is described as it is now.

const DESCRIBE_TIMEOUT_MS = 4_000;

function within(promise, ms, what) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what}: no answer within ${ms / 1000} s`)), ms);
    }),
  ]);
}

// The installed plugins, each with its capabilities or the reason it has none. A query that is
// exactly a plugin's id asks that plugin alone.
async function describePlugins(client, query) {
  const listed = await client.listPlugins();
  const wanted = String(query ?? "").trim().toLowerCase();
  const exact = wanted ? listed.find((p) => p.id.toLowerCase() === wanted) : null;
  return Promise.all(
    (exact ? [exact] : listed).map(async (plugin) => {
      const entry = { id: plugin.id, name: plugin.name ?? plugin.id, capabilities: null, reason: "" };
      if (plugin.status !== "running") return { ...entry, reason: `not running (${plugin.status})` };
      try {
        const parsed = parseCapabilities(await within(client.invokePluginRpc(plugin.id, DESCRIBE_METHOD, {}), DESCRIBE_TIMEOUT_MS, DESCRIBE_METHOD));
        return parsed.invalid ? { ...entry, reason: `its ${DESCRIBE_METHOD} is not usable: ${parsed.invalid}` } : { ...entry, capabilities: parsed.capabilities };
      } catch (error) {
        const message = String(error?.message ?? error);
        return { ...entry, reason: /does not contribute RPC/i.test(message) ? "does not describe itself to ChatGPT" : truncate(message, 160) };
      }
    }),
  );
}

function pluginData(entry) {
  const caps = entry.capabilities;
  if (!caps) return { id: entry.id, title: entry.name, available: false, reason: entry.reason };
  return {
    id: entry.id,
    title: caps.title,
    summary: caps.summary,
    available: true,
    reads: caps.operations.filter((op) => op.kind === "read").map(readSummary),
    actions: caps.operations.filter((op) => op.kind === "action").map(actionSummary),
    // For the plugin's author: what its description offered that God Mode could not use, and why.
    ...(caps.skipped.length ? { skipped: caps.skipped } : {}),
  };
}

function catalogText(entries) {
  const usable = entries.filter((e) => e.capabilities);
  const others = entries.filter((e) => !e.capabilities);
  const lines = [usable.length ? "Plugins ChatGPT can use:" : "No installed plugin offers anything to ChatGPT yet."];
  for (const { id, capabilities: caps } of usable) {
    const reads = caps.operations.filter((op) => op.kind === "read").map((op) => `${op.id}${op.default ? " (main)" : ""}`);
    lines.push(`- ${caps.title} (${id}): ${caps.summary}`.trimEnd());
    lines.push(`  Reads (plugin_read): ${reads.join(", ") || "none"}.`);
    const actions = actionsLine(caps);
    if (actions) lines.push(`  ${actions}`);
    if (caps.skipped.length) lines.push(`  Dropped from its description: ${caps.skipped.map((s) => `${s.id} (${s.reason})`).join("; ")}.`);
  }
  if (others.length) lines.push(`Installed, nothing for ChatGPT: ${others.map((e) => `${e.name} (${e.reason})`).join("; ")}.`);
  return lines.join("\n");
}

// A plugin the user named, among those that describe themselves, or the question to ask.
async function pickDescribed(client, query) {
  const entries = await describePlugins(client, query);
  const found = pickPlugin(entries, query);
  if (found.match && !found.match.capabilities) {
    return { ask: { text: `${found.match.name} is installed but offers nothing to ChatGPT: ${found.match.reason}.`, data: { plugins: [pluginData(found.match)] } } };
  }
  if (found.match) return { entry: found.match };
  const usable = entries.filter((e) => e.capabilities);
  const names = found.candidates.length ? found.candidates : usable;
  const lines = names.map((e) => `${e.capabilities?.title ?? e.name} (${e.id})`);
  const text = found.candidates.length
    ? candidatesText("plugin", query, lines)
    : `No plugin matches "${query}". ${usable.length ? `Plugins ChatGPT can use: ${lines.join(", ")}.` : "No installed plugin offers anything to ChatGPT."}`;
  return { ask: clarification("plugin", query, text, names.map(pluginData)) };
}

function operationQuestion(entry, query, candidates, kind) {
  const caps = entry.capabilities;
  const lines = candidates.map((op) => `${op.id}: ${op.title}${kind === "action" ? ` (${signature(op)})` : ""}`);
  const text = query ? candidatesText(`${caps.title} ${kind}`, query, lines) : `Name the ${kind} of ${caps.title} to use:\n${lines.map((l) => `- ${l}`).join("\n")}`;
  return clarification("operation", query, text, candidates.map((op) => ({ id: op.id, title: op.title })));
}

export async function pluginRead(pairingUrl, args = {}) {
  return withDaemon(pairingUrl, (client) => pluginReadOn(client, args));
}

// plugin_read over an open connection: without a plugin, what every plugin offers; with one, one
// of its reads (its main one unless named), trimmed to the fields it marked worth reading, and
// the plugin's other reads and its actions.
export async function pluginReadOn(client, { plugin, operation, args } = {}) {
  if (!String(plugin ?? "").trim()) {
    const entries = await describePlugins(client);
    return { text: catalogText(entries), data: { plugins: entries.map(pluginData) } };
  }
  const picked = await pickDescribed(client, plugin);
  if (picked.ask) return picked.ask;
  const { entry } = picked;
  const caps = entry.capabilities;
  const found = pickOperation(caps, operation, "read");
  if (found.wrongKind) return { invalid: `${found.wrongKind.id} is an action of ${caps.title}: use plugin_action.` };
  // A plugin with no main read answers with what it offers rather than with a question.
  if (!found.match && !operation) return { text: catalogText([entry]), data: { plugins: [pluginData(entry)] } };
  if (!found.match) return operationQuestion(entry, operation, found.candidates, "read");
  const op = found.match;
  const prepared = prepareArgs(op, args);
  if (prepared.invalid) return { invalid: prepared.invalid };
  const output = await client.invokePluginRpc(entry.id, op.method, prepared.args);
  const verdict = judgeOutcome(op, output);
  const result = projectResult(op, output);
  const marked = op.untrusted ? { untrusted: true } : {};
  const data = { plugin: entry.id, title: caps.title, operation: op.id, ...(op.description ? { about: op.description } : {}), ...marked };
  if (verdict.refused) {
    return {
      text: [`${caps.title} · ${op.title}: could not read it. ${verdict.reason}`, op.untrusted && UNTRUSTED_NOTE].filter(Boolean).join("\n"),
      data: { ...data, refused: true, reason: verdict.reason, result },
    };
  }
  // The plugin's other reads come with the answer as its actions do: the catalog lists them too,
  // but a model that went straight to the plugin never asked for it.
  const reads = otherReads(caps, op.id);
  return {
    text: [
      `${caps.title} · ${op.title}`,
      op.description && truncate(op.description, 300),
      op.untrusted && UNTRUSTED_NOTE,
      resultLines(result, 1500, op.chronological),
      readsLine(caps, op.id),
      actionsLine(caps),
    ]
      .filter(Boolean)
      .join("\n"),
    data: {
      ...data,
      result,
      ...(reads.length ? { reads: reads.map(readSummary) } : {}),
      actions: caps.operations.filter((o) => o.kind === "action").map(actionSummary),
    },
  };
}

// The facts about an action's target, read from the plugin with the read the action names, its
// arguments taken from the action's. Any failure (the arguments, the call, the read's own outcome,
// a missing field) means the target cannot be shown, so nothing may run.
async function readTarget(client, entry, op, args) {
  const read = entry.capabilities.operations.find((candidate) => candidate.id === op.target.read);
  const mapped = Object.fromEntries(Object.entries(op.target.args).filter(([, from]) => args[from] !== undefined).map(([to, from]) => [to, args[from]]));
  const prepared = prepareArgs(read, mapped);
  if (prepared.invalid) return { unavailable: prepared.invalid };
  let output;
  try {
    output = await client.invokePluginRpc(entry.id, read.method, prepared.args);
  } catch (error) {
    return { unavailable: truncate(String(error?.message ?? error), 200) };
  }
  const verdict = judgeOutcome(read, output);
  if (verdict.refused) return { unavailable: verdict.reason };
  const shown = targetFacts(op.target, output);
  return shown.missing ? { unavailable: shown.missing } : { facts: shown.facts };
}

export async function pluginAction(pairingUrl, args = {}) {
  // The pairing link is the Site's one secret, so confirmations are signed with it.
  return withDaemon(pairingUrl, (client) => pluginActionOn(client, { ...args, secret: pairingUrl }));
}

// plugin_action over an open connection. A low-risk action runs at once; anything else runs only
// with the confirmation issued for exactly these arguments, after ChatGPT read its text to the user.
export async function pluginActionOn(client, { plugin, operation, args, confirmation, secret, now = Date.now() } = {}) {
  const picked = await pickDescribed(client, plugin);
  if (picked.ask) return picked.ask;
  const { entry } = picked;
  const caps = entry.capabilities;
  const found = pickOperation(caps, operation, "action");
  if (found.wrongKind) return { invalid: `${found.wrongKind.id} is a read of ${caps.title}: use plugin_read.` };
  if (!found.match) return operationQuestion(entry, operation, found.candidates, "action");
  const op = found.match;
  const prepared = prepareArgs(op, args);
  if (prepared.invalid) return { invalid: prepared.invalid };
  const base = { plugin: entry.id, title: caps.title, operation: op.id };
  if (op.confirm === "always") {
    // The target is read on both calls: once to show it, once more right before running, so a
    // target that changed in between is asked about again instead of acted on.
    let facts = null;
    if (op.target) {
      const shown = await readTarget(client, entry, op, prepared.args);
      if (shown.unavailable) {
        const reason = `its target could not be read: ${shown.unavailable}`;
        return { text: `Not done: ${caps.title} · ${op.title}, ${reason}. Nothing happened.`, data: { ...base, outcome: "refused", delivered: false, reason } };
      }
      facts = shown.facts;
    }
    const subject = { plugin: entry.id, operation: op.id, method: op.method, args: prepared.args };
    const verdict = confirmation ? await checkConfirmation(secret, confirmation, subject, now, facts) : "none";
    if (verdict !== "ok") {
      const { token, expiresAt } = await issueConfirmation(secret, subject, now, facts);
      const say = confirmationText(caps, op, prepared.args, facts);
      const why = {
        none: "",
        expired: "That confirmation expired. ",
        mismatch: "That confirmation was for something else. ",
        changed: "The target changed since the user confirmed; tell them what it is now. ",
      }[verdict];
      return {
        text: `${why}Not done: this action asks first. Tell the user: "${say}" Only after they say yes, call plugin_action again with the same plugin, operation and args plus this confirmation.`,
        data: {
          ...base,
          outcome: "needs_confirmation",
          delivered: false,
          risk: op.risk,
          confirm_text: say,
          confirmation: token,
          expires_at: expiresAt,
          ...(facts ? { target: facts } : {}),
          ...(verdict === "changed" ? { target_changed: true } : {}),
        },
      };
    }
  }
  const output = await client.invokePluginRpc(entry.id, op.method, prepared.args);
  const verdict = judgeOutcome(op, output);
  const result = projectResult(op, output);
  const marked = op.untrusted ? { untrusted: true } : {};
  if (verdict.refused) {
    return {
      text: [`Not done: ${caps.title} · ${op.title}. ${verdict.reason}. Nothing happened; tell the user why.`, op.untrusted && UNTRUSTED_NOTE].filter(Boolean).join("\n"),
      data: { ...base, outcome: "refused", delivered: false, reason: verdict.reason, result, ...marked },
    };
  }
  return {
    text: [`Done: ${caps.title} · ${op.title}. It ran once; never repeat it for this request.`, op.untrusted && UNTRUSTED_NOTE, resultLines(result, 800)].filter(Boolean).join("\n"),
    data: { ...base, outcome: "done", delivered: true, result, ...marked },
  };
}
