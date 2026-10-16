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
  candidatesText,
  chatData,
  chatLine,
  chatState,
  describePermission,
  describeRelease,
  latestFirstWithin,
  releaseData,
  resolve,
  snippet,
  toIso,
  toolCallData,
  truncate,
} from "./text.mjs";

const CONNECT_TIMEOUT_MS = 8_000;
const MAX_WAIT_SECONDS = 25;
const CHAT_PAGE = 200;
const TURN_ENTRIES = 400;
const COMMANDS_SHOWN = 8;
const MAX_TURNS = 10;
const SEARCH_SCAN = { default: 20, max: 50 };
const SEARCH_CONCURRENCY = 8;
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
// including archived ones. Returns { chat } or { ask }.
async function pickChat(client, query, chats) {
  const all = chats ?? (await fetchChats(client));
  const found = resolve(all, query, { text: (c) => `${c.title} ${c.project}` });
  if (found.match) return { chat: found.match };
  const raw = String(query ?? "").trim().replace(/^#/, "");
  if (UUID.test(raw)) {
    const fetched = await client.fetchAgent(raw);
    if (fetched) return { chat: toChat(fetched) };
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

export async function overview(pairingUrl, { hours = 12 } = {}) {
  return withDaemon(pairingUrl, async (client) => {
    const [projects, chats] = await Promise.all([fetchProjects(client), fetchChats(client)]);
    const now = Date.now();
    const since = now - hours * 3_600_000;
    const waiting = chats.filter(isWaiting);
    const running = chats.filter((c) => !isWaiting(c) && isRunning(c));
    const replies = chats.filter((c) => !isWaiting(c) && !isRunning(c) && c.attention && Date.parse(c.updatedAt) >= since);
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
    const hint = "\nPass a #id above straight to read_chat or send_message; no need to list again.";
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

function turnText(turn) {
  const items = turn.items;
  return {
    user: items.find((i) => i.type === "user_message")?.text ?? turn.preview ?? "",
    agent: items.filter((i) => i.type === "assistant_message").map((i) => i.text),
    errors: items.filter((i) => i.type === "error").map((i) => i.message),
    calls: items.filter((i) => i.type === "tool_call"),
  };
}

const OMITTED = /^\((\d+) earlier message\(s\) omitted\)\n\n/;

function renderTurnsText(target, loaded, max) {
  const perTurn = Math.floor(max / loaded.turns.length);
  const userMax = loaded.turns.length === 1 ? 300 : 200;
  const shaped = loaded.turns.map((t) => {
    const { user, agent, errors } = turnText(t);
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
      },
    };
  });
  const turns = shaped.map((s) => s.data);
  const header = chatLine(target);
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
  const lines = [chatLine(target)];
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
        snippet: snippet(entry?.item?.text ?? "", query),
      };
    }),
  );
  return { chat, total: locations.length, matches };
}

function matchLine(chat, m) {
  return `#${chat.id.slice(0, 7)} ${truncate(chat.title, 50)} - ${chat.project}: turn ${m.turn} (${m.role}): ${m.snippet}`;
}

export async function readChat(pairingUrl, { chat, view = "text", turn = 1, turns = 1, query, maxChars } = {}) {
  const count = clamp(Math.trunc(turns) || 1, 1, MAX_TURNS);
  const from = Math.max(1, Math.trunc(turn) || 1);
  const max = clamp(maxChars ?? (count === 1 ? 1500 : Math.min(6000, 800 * count)), 200, 6000);
  return withDaemon(pairingUrl, async (client) => {
    const picked = await pickChat(client, chat);
    if (picked.ask) return picked.ask;
    const target = picked.chat;
    const header = chatLine(target);

    if (view === "turns") {
      const { prompts = [] } = await client.listAgentTimelinePrompts(target.id);
      const latest = prompts.slice(-12).reverse().map((p, i) => ({ turn: i + 1, position: prompts.length - i, started_at: toIso(p.timestamp), preview: truncate(p.preview, 120) }));
      return {
        text: [header, `${prompts.length} turn(s), latest first:`, ...latest.map((t) => `${t.turn}. ${t.preview}`)].join("\n"),
        data: { chat: chatData(target), total_turns: prompts.length, turns: latest },
      };
    }

    if (view === "search") {
      if (!query) return { text: "Searching a chat needs a query.", data: { chat: chatData(target), query: "", total_matches: 0, matches: [] } };
      const result = await searchChat(client, target, query, 8);
      const data = { chat: chatData(target), query, total_matches: result.total, matches: result.matches };
      if (result.total === 0) return { text: `${header}\nNo matches for "${query}".`, data };
      return {
        text: [header, `${result.total} match(es) for "${query}", turns counted from the latest:`, ...result.matches.map((m) => `turn ${m.turn} (${m.role}): ${m.snippet}`)].join("\n"),
        data,
      };
    }

    const loaded = await loadTurns(client, target.id, from, count);
    if (loaded.missing) {
      return { text: `${header}\n${loaded.missing}`, data: { chat: chatData(target), total_turns: loaded.total, turns: [] } };
    }
    return view === "commands" ? renderTurnsCommands(target, loaded, max) : renderTurnsText(target, loaded, max);
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
  if (wait === 0) return { text: "Not waiting for the reply; read the chat later.", data: { outcome: "not_waiting" } };
  const state = await client.waitForFinish(agentId, wait * 1000);
  switch (state.status) {
    case "idle": {
      const reply = truncate(state.lastMessage ?? "(no text)", 1500);
      return { text: `Agent replied: ${reply}`, data: { outcome: "replied", reply } };
    }
    case "permission": {
      const pending = state.final?.pendingPermissions?.[0];
      const approval = pending ? describePermission(pending) : "a tool call";
      return { text: `Agent is waiting for approval: ${approval}.`, data: { outcome: "waiting_for_approval", approval } };
    }
    case "error": {
      const error = truncate(state.error ?? "unknown", 300);
      return { text: `Agent stopped with an error: ${error}`, data: { outcome: "error", error } };
    }
    default:
      return { text: "Agent is still working. Tell the user, and read the chat when they ask.", data: { outcome: "still_working" } };
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
      text: `Started chat #${agent.id.slice(0, 7)} in ${picked.project.name}.\n${outcome.text}`,
      data: { chat_id: agent.id, short_id: agent.id.slice(0, 7), project: picked.project.name, ...outcome.data },
    };
  });
}

export async function sendMessage(pairingUrl, { chat, text, ifBusy, waitSeconds = 15 } = {}) {
  return withDaemon(pairingUrl, async (client) => {
    const picked = await pickChat(client, chat);
    if (picked.ask) return picked.ask;
    const target = picked.chat;
    const busy = isRunning(target);
    if (busy && !ifBusy) {
      return {
        text: `${chatLine(target)}\nThis chat is busy. Ask the user whether to interrupt it or add the message to the current work, then call again with if_busy.`,
        data: { chat_id: target.id, short_id: target.id.slice(0, 7), outcome: "busy" },
      };
    }
    await client.sendAgentMessage(target.id, text, busy ? { activeTurnBehavior: ifBusy } : undefined);
    const outcome = await awaitReply(client, target.id, waitSeconds);
    return {
      text: `Sent to #${target.id.slice(0, 7)} ${truncate(target.title, 70)}.\n${outcome.text}`,
      data: { chat_id: target.id, short_id: target.id.slice(0, 7), project: target.project, ...outcome.data },
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
      return { text: `${chatLine(target)}\nNothing is waiting for approval in this chat.`, data: { chat_id: target.id, done: false, what: null } };
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
      text: `${behavior === "allow" ? "Allowed" : "Denied"}: ${what} in #${target.id.slice(0, 7)}.`,
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
      return { text: `${chatLine(target)}\nIt is not running; nothing to stop.`, data: { chat_id: target.id, done: false } };
    }
    await client.cancelAgent(target.id);
    return {
      text: `Stopped #${target.id.slice(0, 7)} ${truncate(target.title, 70)}. State before: ${chatState(target)}.`,
      data: { chat_id: target.id, done: true },
    };
  });
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
