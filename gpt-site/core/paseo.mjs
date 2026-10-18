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
  chatState,
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
  pickActive,
  releaseData,
  repliedOutcome,
  resolve,
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
  parseCapabilities,
  pickOperation,
  pickPlugin,
  prepareArgs,
  projectResult,
  readSummary,
  resultLines,
  signature,
  targetFacts,
  UNTRUSTED_NOTE,
} from "./capabilities.mjs";

const CONNECT_TIMEOUT_MS = 8_000;
const MAX_WAIT_SECONDS = 25;
const CHAT_PAGE = 200;
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

// Resolves a spoken chat reference among active chats, or a full id of any chat
// including archived ones. Returns { chat, note? } or { ask }. Reads take the one
// active chat among several matches ("the agent in jobby") and say so in `note`;
// writes always ask.
async function pickChat(client, query, chats, { read = false } = {}) {
  const all = chats ?? (await fetchChats(client));
  const found = resolve(all, query, { text: (c) => `${c.title} ${c.project}` });
  if (found.match) return { chat: found.match };
  const raw = String(query ?? "").trim().replace(/^#/, "");
  if (UUID.test(raw)) {
    const fetched = await client.fetchAgent(raw);
    if (fetched) return { chat: toChat(fetched) };
  }
  const active = read ? pickActive(found.top ?? found.candidates) : null;
  if (active) {
    const matches = (found.top ?? found.candidates).length;
    return { chat: active, note: `"${query}" matches ${matches} chats; this is the only active one.` };
  }
  const lines = found.candidates.map((c) => chatLine(c));
  return { ask: clarification("chat", query, candidatesText("chat", query, lines), found.candidates.map((c) => chatData(c))) };
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
  const items = turn.items;
  const agent = [];
  const images = [];
  for (const item of items.filter((i) => i.type === "assistant_message")) {
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
export async function readActivity(pairingUrl, { chat, maxChars } = {}) {
  const max = clamp(maxChars ?? 1500, 200, 6000);
  return withDaemon(pairingUrl, async (client) => {
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
  });
}

// Finds where something was said, across many chats at once: Paseo searches
// one chat at a time, so the chats are searched here in parallel.
export async function searchMessages(pairingUrl, { query, project, chat, includeArchived = false, scan, limit = 10 } = {}) {
  const wanted = clamp(Math.trunc(limit) || 10, 1, 30);
  return withDaemon(pairingUrl, async (client) => {
    let candidates;
    if (chat) {
      const picked = await pickChat(client, chat);
      if (picked.ask) return picked.ask;
      candidates = [picked.chat];
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
      return { text: `No messages matching "${query}" in the ${candidates.length} most recent chat(s) searched.`, data };
    }
    const totalMatches = hits.reduce((n, r) => n + r.total, 0);
    data.total_matches = totalMatches;
    const shown = matches.length < totalMatches ? `; ${matches.length} of ${totalMatches} matches shown` : "";
    return {
      text: [`"${query}" found in ${hits.length} of ${candidates.length} chat(s) searched${shown}:`, ...matches.map((m) => matchLine(m.chat, m))].join("\n"),
      data,
    };
  });
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

export async function startChat(pairingUrl, { project, prompt, model, thinking, mode, waitSeconds = 15 } = {}) {
  return withDaemon(pairingUrl, async (client) => {
    const picked = pickProject(await fetchProjects(client), project);
    if (picked.ask) return picked.ask;
    const agent = await client.createAgent({
      provider: "claude",
      cwd: picked.project.directory,
      initialPrompt: prompt,
      ...(model ? { model } : {}),
      ...(thinking ? { thinkingOptionId: thinking } : {}),
      ...(mode ? { modeId: mode } : {}),
      labels: { source: "god-mode" },
    });
    const outcome = await awaitReply(client, agent.id, waitSeconds);
    return {
      text: `Started a new chat in ${picked.project.name}; the task arrived. Do not start it again.\n${outcome.text}`,
      data: { chat_id: agent.id, short_id: agent.id.slice(0, 7), project: picked.project.name, ...outcome.data },
    };
  });
}

export async function sendMessage(pairingUrl, { chat, text, ifBusy, waitSeconds = 15 } = {}) {
  return withDaemon(pairingUrl, async (client) => {
    const picked = await pickChat(client, chat);
    if (picked.ask) return picked.ask;
    const target = picked.chat;
    const ids = { chat_id: target.id, short_id: target.id.slice(0, 7), project: target.project };
    const busy = isRunning(target);
    if (busy && !ifBusy) {
      return {
        text: `Not sent: ${truncate(target.title, 70)} is busy. Ask the user whether to add this to its current work or interrupt it, then call again with if_busy.`,
        data: { ...ids, outcome: "busy", delivered: false },
      };
    }
    await client.sendAgentMessage(target.id, text, busy ? { activeTurnBehavior: ifBusy } : undefined);
    const outcome = await awaitReply(client, target.id, waitSeconds);
    return {
      text: `Sent to ${truncate(target.title, 70)}; it arrived. Do not send it again.\n${outcome.text}`,
      data: { ...ids, ...outcome.data },
    };
  });
}

export async function answerApproval(pairingUrl, { chat, decision, request } = {}) {
  return withDaemon(pairingUrl, async (client) => {
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
    // Press the same button the app would show ("Implement", "Reject", …).
    const action = permission.actions?.find((a) => a.behavior === behavior);
    const response = {
      behavior,
      ...(action ? { selectedActionId: action.id } : {}),
      ...(behavior === "deny" ? { message: "Denied by voice." } : {}),
    };
    await client.respondToPermissionAndWait(target.id, permission.id, response, 10_000);
    const what = describePermission(permission);
    return {
      text: `${behavior === "allow" ? "Allowed" : "Denied"}: ${what} in ${truncate(target.title, 70)}.`,
      data: { chat_id: target.id, done: true, decision: behavior, what },
    };
  });
}

export async function stopChat(pairingUrl, { chat } = {}) {
  return withDaemon(pairingUrl, async (client) => {
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
  });
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
// of its reads (its main one unless named), trimmed to the fields it marked worth reading.
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
  return {
    text: [`${caps.title} · ${op.title}`, op.description && truncate(op.description, 300), op.untrusted && UNTRUSTED_NOTE, resultLines(result), actionsLine(caps)]
      .filter(Boolean)
      .join("\n"),
    data: { ...data, result, actions: caps.operations.filter((o) => o.kind === "action").map(actionSummary) },
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
