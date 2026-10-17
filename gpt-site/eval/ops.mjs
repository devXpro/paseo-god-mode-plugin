// Fake Paseo operations for the eval stub: the same names, arguments and { text, data } results as
// core/paseo.mjs, computed over the fake world instead of a relay connection. Nothing in here opens
// a socket. The pure helpers come from the version under test (its text.mjs), so the selection
// rules, the subagent view and the wording are that version's own; features a version lacks are
// detected and skipped. Write operations change the world and take their outcome from the
// scenario, so a case can force busy, an error or a timeout.

import { NEW_CHAT_ID } from "./world.mjs";

const WRITE_DEFAULTS = { start_chat: "still_working", send_message: "auto", answer_approval: "ok", stop_chat: "ok", update_site: "ok" };

// Release fixtures relative to the Site version under test: the Mac has the same, a newer one, or
// GitHub has a newer one than the Mac.
const nextMinor = (version) => {
  const [major, minor] = version.split(".").map(Number);
  return `${major}.${minor + 1}.0`;
};
const RELEASES = {
  uptodate: (v) => ({ installed: v, live: { versionNumber: 11 }, latest: { version: v, newer: false }, job: null }),
  available: (v) => ({ installed: nextMinor(v), live: { versionNumber: 11 }, latest: { version: nextMinor(v), newer: false }, job: null }),
  github_newer: (v) => ({ installed: v, live: { versionNumber: 11 }, latest: { version: nextMinor(v), newer: true }, job: null }),
};

export function createOps({ world, scenario = {}, text, PaseoOffline, siteVersion = "0.5.0", record = () => {} }) {
  const { resolve, chatData, chatLine, candidatesText, describePermission, latestFirstWithin, toIso, toolCallData, truncate, snippet, releaseData, describeRelease, chatState } = text;
  // Since 0.6.0: reads pick the one active chat, read_activity and subagent counts exist.
  const modern = typeof text.activityData === "function";
  // Since 0.7.2 send results say whether the message arrived; earlier versions do not.
  const saysDelivered = text.repliedOutcome?.("x")?.data?.delivered === true;
  const flag = (delivered) => (saysDelivered ? { delivered } : {});
  const now = world.now;
  const queues = Object.fromEntries(Object.entries(scenario.outcomes ?? {}).map(([k, v]) => [k, [...v]]));
  const state = { recording: true, created: 0 };
  const release = RELEASES[scenario.release ?? "uptodate"](siteVersion);

  const takeOutcome = (tool) => (queues[tool]?.length ? queues[tool].shift() : (scenario.defaults?.[tool] ?? WRITE_DEFAULTS[tool]));
  const fail = (outcome) => {
    if (outcome === "error") throw new Error("relay closed the connection before the daemon answered");
    if (outcome === "unknown") throw new Error("no answer within 45 s");
    if (outcome === "offline") throw new PaseoOffline("connect timed out");
  };
  const log = (op, args, outcome) => state.recording && record({ op, args, outcome });

  const active = () => world.chats.filter((c) => !c.archived).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  const isRunning = (c) => ["running", "initializing"].includes(c.status);
  const isWaiting = (c) => c.permissions.length > 0 || c.attention === "permission";
  const clarification = (kind, query, message, candidates) => ({ text: message, data: { needs_clarification: { kind, query: String(query ?? ""), candidates } } });
  const runningSubagents = (c) => c.subagents.filter((s) => s.status === "running").length;

  function pickChat(query, { read = false } = {}) {
    const found = resolve(active(), query, { text: (c) => `${c.title} ${c.project}` });
    if (found.match) return { chat: found.match };
    const raw = String(query ?? "").trim().replace(/^#/, "");
    const full = world.chats.find((c) => c.id === raw);
    if (full) return { chat: full };
    const pick = read && modern ? text.pickActive(found.top ?? found.candidates) : null;
    if (pick) return { chat: pick, note: `"${query}" matches ${(found.top ?? found.candidates).length} chats; this is the only active one.` };
    const lines = found.candidates.map((c) => chatLine(c, now));
    return { ask: clarification("chat", query, candidatesText("chat", query, lines), found.candidates.map((c) => chatData(c, now))) };
  }
  const withNote = (result, note) => (note ? { text: `${note}\n${result.text}`, data: { ...result.data, note } } : result);

  function pickProject(query) {
    const found = resolve(world.projects, query, { id: () => "", text: (p) => p.name });
    if (found.match) return { project: found.match };
    if (found.candidates.length === 0) {
      const names = world.projects.map((p) => p.name);
      return { ask: clarification("project", query, `No project matches "${query}". Projects: ${names.join(", ")}.`, names) };
    }
    const names = found.candidates.map((p) => p.name);
    return { ask: clarification("project", query, candidatesText("project", query, names), names) };
  }

  const section = (title, chats) => (chats.length ? [`${title}:`, ...chats.slice(0, 8).map((c) => chatLine(c, now))] : []);

  async function overview(_url, { hours = 12 } = {}) {
    log("overview", { hours });
    const chats = active().map((c) => ({ ...c }));
    const since = now - hours * 3_600_000;
    const waiting = chats.filter(isWaiting);
    const busy = chats.filter((c) => !isWaiting(c) && isRunning(c));
    const recent = chats.filter((c) => !isWaiting(c) && !isRunning(c) && c.attention && Date.parse(c.updatedAt) >= since);
    if (modern) for (const c of [...busy.slice(0, 8), ...recent.slice(0, 8)]) c.subagentsRunning = runningSubagents(c);
    const running = [...busy, ...recent.filter((c) => c.subagentsRunning > 0)];
    const replies = recent.filter((c) => !(c.subagentsRunning > 0));
    const perProject = world.projects.map((p) => ({ name: p.name, chats: chats.filter((c) => c.project === p.name).length }));
    const summary =
      waiting.length + running.length + replies.length === 0
        ? "Nothing needs the user right now and no chat is running."
        : `${waiting.length} waiting for the user, ${running.length} running, ${replies.length} with a new reply or error.`;
    return {
      text: [
        summary,
        ...section("Waiting for the user", waiting),
        ...section("Running", running),
        ...section(`New replies and errors, last ${hours} h`, replies),
        `Projects (chats): ${perProject.map((p) => `${p.name} (${p.chats})`).join(", ")}`,
      ].join("\n"),
      data: {
        summary,
        hours,
        waiting: waiting.map((c) => chatData(c, now)),
        running: running.map((c) => chatData(c, now)),
        new: replies.map((c) => chatData(c, now)),
        projects: perProject,
      },
    };
  }

  const FILTERS = { running: isRunning, waiting: isWaiting, new: (c) => c.attention === "finished" || c.attention === "error", all: () => true };
  const norm = (s) => String(s ?? "").toLowerCase().replaceAll("ё", "е").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

  async function listChats(_url, { project, status = "all", query, includeArchived = false, limit = 10 } = {}) {
    log("listChats", { project, status, query, includeArchived, limit });
    let scope = "all projects";
    let projectName = null;
    if (project) {
      const picked = pickProject(project);
      if (picked.ask) return picked.ask;
      projectName = picked.project.name;
      scope = projectName;
    }
    let chats = active();
    if (query) {
      const q = norm(query);
      const words = q.split(" ").filter(Boolean);
      chats = chats.filter((c) => {
        const hay = norm(`${c.title} ${c.workspace ?? ""} ${c.project}`);
        return hay.includes(q) || words.every((w) => hay.includes(w));
      });
      if (chats.length === 0) {
        const found = resolve(active(), query, { text: (c) => `${c.title} ${c.workspace ?? ""}` });
        chats = found.match ? [found.match] : found.candidates;
      }
    }
    if (projectName) chats = chats.filter((c) => c.project === projectName);
    chats = chats.filter(FILTERS[status] ?? FILTERS.all);
    const shown = chats.slice(0, limit);
    const data = { scope, query: query ?? null, include_archived: includeArchived, total: chats.length, chats: shown.map((c) => chatData(c, now)) };
    if (chats.length === 0) return { text: `No ${status === "all" ? "" : `${status} `}chats in ${scope}${query ? ` matching "${query}"` : ""}.`, data };
    return { text: `${chats.length} chat(s) in ${scope}:\n${shown.map((c) => chatLine(c, now)).join("\n")}`, data };
  }

  function turnsOf(c, from, count) {
    const total = c.turns.length;
    const wanted = [];
    for (let turn = from + count - 1; turn >= from; turn -= 1) {
      const i = total - turn;
      if (i >= 0 && i < total) wanted.push({ turn, position: i + 1, ...c.turns[i] });
    }
    return { total, turns: wanted };
  }

  // The world's subagents as Paseo's descriptors, with the steps and results read from their
  // timelines already filled in.
  function activityOf(c) {
    const turn = c.turns.at(-1);
    const subagents = c.subagents.map((s) => ({
      id: s.id,
      title: s.title,
      description: s.task,
      status: s.status,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      subtitle: `${s.title} · ${s.tokens} tokens`,
      step: s.current,
      result: s.result,
    }));
    const lastCall = turn?.calls?.filter((call) => call.status === "running").at(-1) ?? turn?.calls?.at(-1);
    return text.activityData({ chat: c, subagents, turnStartedAt: turn?.at ?? null, parentStep: isRunning(c) ? text.describeStep(lastCall) : null, now });
  }

  async function readActivity(_url, { chat, maxChars } = {}) {
    log("readActivity", { chat, maxChars });
    if (chat) {
      const picked = pickChat(chat, { read: true });
      if (picked.ask) return picked.ask;
      const a = activityOf(picked.chat);
      return withNote({ text: text.activityText(a), data: { summary: a.working ? "working" : "not working", chats: [a] } }, picked.note);
    }
    const working = active().filter((c) => isRunning(c) || runningSubagents(c) > 0).map(activityOf);
    if (working.length === 0) return { text: "No agent or subagent is working right now.", data: { summary: "Nothing is working right now.", chats: [] } };
    const summary = `${working.length} chat(s) working, ${working.reduce((n, a) => n + a.subagents_running, 0)} subagent(s) running.`;
    return { text: [summary, ...working.map(text.activityText)].join("\n"), data: { summary, chats: working } };
  }

  async function readChat(_url, { chat, view = "text", turn = 1, turns = 1, query, maxChars } = {}) {
    log("readChat", { chat, view, turn, turns, query, maxChars });
    const picked = pickChat(chat, { read: true });
    if (picked.ask) return picked.ask;
    const c = picked.chat;
    const header = chatLine(c, now);
    // Views that only 0.5.0 had.
    if (view === "turns") {
      const latest = [...c.turns].reverse().map((t, i) => ({ turn: i + 1, position: c.turns.length - i, started_at: toIso(t.at), preview: truncate(t.user, 120) }));
      return { text: [header, ...latest.map((t) => `${t.turn}. ${t.preview}`)].join("\n"), data: { chat: chatData(c, now), total_turns: c.turns.length, turns: latest } };
    }
    if (view === "search") {
      const matches = searchIn(c, query ?? "", 8);
      return { text: [header, ...matches.map((m) => `turn ${m.turn} (${m.role}): ${m.snippet}`)].join("\n"), data: { chat: chatData(c, now), query: query ?? "", total_matches: matches.length, matches } };
    }
    const count = Math.min(Math.max(Math.trunc(turns) || 1, 1), 10);
    const loaded = turnsOf(c, Math.max(1, Math.trunc(turn) || 1), count);
    if (loaded.turns.length === 0) return withNote({ text: `${header}\nThe chat has ${loaded.total} turn(s).`, data: { chat: chatData(c, now), total_turns: loaded.total, turns: [] } }, picked.note);
    const max = maxChars ?? (count === 1 ? 1500 : 800 * count);
    const perTurn = Math.floor(max / loaded.turns.length);
    if (view === "commands") {
      const out = loaded.turns.map((t) => ({ turn: t.turn, position: t.position, started_at: toIso(t.at), total_tool_calls: t.calls.length, tool_calls: t.calls.slice(-8).map((call) => toolCallData(call, 200)) }));
      return withNote(
        { text: [header, ...out.map((t) => `Turn ${t.turn} of ${loaded.total}: ${t.tool_calls.map((x) => x.text).join("; ") || "no commands"}`)].join("\n"), data: { chat: chatData(c, now), total_turns: loaded.total, turns: out } },
        picked.note,
      );
    }
    const out = loaded.turns.map((t) => {
      const { agent, images } = shapeAgent(t);
      return {
        turn: t.turn,
        position: t.position,
        started_at: toIso(t.at),
        ended_at: toIso(t.end),
        user_text: truncate(t.user, count === 1 ? 300 : 200),
        agent_text: latestFirstWithin(agent, perTurn).replace(/^\(\d+ earlier message\(s\) omitted\)\n\n/, ""),
        omitted_messages: 0,
        errors: [],
        ...(images.length ? { images: images.map((i) => text.imageRef(i, c.cwd)) } : {}),
      };
    });
    return withNote(
      {
        text: [
          header,
          ...out.flatMap((t) => [
            `Turn ${t.turn} of ${loaded.total}. User asked: ${t.user_text}`,
            t.agent_text ? `Agent replied: ${t.agent_text}` : "Agent has not replied in this turn yet.",
            ...(t.images ? [text.imageHint(t.turn, t.images.length)] : []),
          ]),
        ].join("\n"),
        data: { chat: chatData(c, now), total_turns: loaded.total, turns: out },
      },
      picked.note,
    );
  }

  // Since 0.7: a turn's images read as [image N], numbered through the turn; before, as the
  // markdown the daemon records.
  const placeholders = typeof text.withImagePlaceholders === "function";
  function shapeAgent(t) {
    if (!placeholders) return { agent: t.agent, images: [] };
    const images = [];
    const agent = t.agent.map((message) => {
      const shaped = text.withImagePlaceholders(message, images.length + 1);
      images.push(...shaped.images);
      return shaped.text;
    });
    return { agent, images };
  }

  // A chat's images, newest first, each with its turn (1 = latest) and its N in that turn.
  const imagesOf = (c) =>
    c.turns
      .flatMap((t, i) => shapeAgent(t).images.map((image) => ({ ...image, turn: c.turns.length - i })))
      .reverse();

  // show_images over the fake world; the bytes are a 1x1 PNG. Versions before 0.7 lack the tool.
  const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  async function showImages(_url, { chat, turn, image, count } = {}) {
    log("showImages", { chat, turn, image, count });
    let c;
    let note;
    if (chat) {
      const picked = pickChat(chat, { read: true });
      if (picked.ask) return picked.ask;
      c = picked.chat;
      note = picked.note;
    } else {
      c = active().find((x) => imagesOf(x).length > 0);
      if (!c) return { text: "No images in the latest turns of the 8 most recent chats.", data: { total_images: 0, images: [], skipped: [] } };
    }
    const from = turn || image ? Math.max(1, Math.trunc(turn) || 1) : null;
    const all = imagesOf(c).filter((i) => !from || i.turn === from);
    const limit = Math.min(Math.max(Math.trunc(count) || (from ? 4 : 1), 1), 4);
    const chosen = image ? all.filter((i) => i.n === image) : all.slice(0, limit);
    const shown = chosen.map((i) => ({ ...i, name: text.imageName(i), mime: "image/png", bytes: 70 }));
    const reply = text.imagesText({ chat: c, turn: from, found: all.length, shown, skipped: [] });
    return {
      text: note ? `${note}\n${reply}` : reply,
      data: {
        chat: chatData(c, now),
        ...(note ? { note } : {}),
        total_images: all.length,
        images: shown.map((i) => ({ n: i.n, turn: i.turn, name: i.name, mime: i.mime, bytes: i.bytes })),
        skipped: [],
      },
      ...(shown.length
        ? { meta: { "god-mode/images": { chat: { title: c.title, project: c.project }, images: shown.map((i) => ({ n: i.n, turn: i.turn, name: i.name, mime: i.mime, data: PIXEL })) } } }
        : {}),
    };
  }

  function searchIn(c, query, perChat) {
    const q = norm(query);
    const words = q.split(" ").filter((w) => w.length >= 4);
    const hit = (s) => {
      const hay = norm(s);
      return (q && hay.includes(q)) || words.some((w) => hay.split(" ").some((h) => h.startsWith(w.slice(0, Math.max(4, w.length - 2)))));
    };
    const matches = [];
    c.turns.forEach((t, i) => {
      const turnNo = c.turns.length - i;
      if (hit(t.user)) matches.push({ turn: turnNo, role: "user", at: toIso(t.at), snippet: snippet(t.user, query) });
      for (const m of t.agent) if (hit(m)) matches.push({ turn: turnNo, role: "assistant", at: toIso(t.end ?? t.at), snippet: snippet(m, query) });
    });
    return matches.slice(0, perChat);
  }

  async function searchMessages(_url, { query, project, chat, includeArchived = false, scan, limit = 10 } = {}) {
    log("searchMessages", { query, project, chat, includeArchived, scan, limit });
    let candidates;
    if (chat) {
      const picked = pickChat(chat);
      if (picked.ask) return picked.ask;
      candidates = [picked.chat];
    } else {
      candidates = active();
      if (project) {
        const picked = pickProject(project);
        if (picked.ask) return picked.ask;
        candidates = candidates.filter((c) => c.project === picked.project.name);
      }
    }
    const hits = candidates.map((c) => ({ chat: c, matches: searchIn(c, query, chat ? 8 : 2) })).filter((h) => h.matches.length);
    const matches = hits.flatMap((h) => h.matches.map((m) => ({ chat: h.chat, ...m }))).slice(0, limit);
    const data = {
      query,
      searched_chats: candidates.length,
      matched_chats: hits.length,
      total_matches: matches.length,
      matches: matches.map(({ chat: c, ...m }) => ({ chat: { id: c.id, short_id: c.id.slice(0, 7), title: c.title, project: c.project, updated_at: toIso(c.updatedAt), archived: c.archived }, ...m })),
    };
    if (matches.length === 0) return { text: `No messages matching "${query}" in the ${candidates.length} most recent chat(s) searched.`, data };
    return { text: [`"${query}" found in ${hits.length} chat(s):`, ...matches.map((m) => `${m.chat.title} (${m.chat.project}), turn ${m.turn} (${m.role}): ${m.snippet}`)].join("\n"), data };
  }

  function outcomeOf(outcome) {
    if (outcome === "replied") return { text: "Agent replied: Принял, делаю.", data: { outcome: "replied", ...flag(true), reply: "Принял, делаю." } };
    if (outcome === "not_waiting") return { text: "Not waiting for the reply; offer to check later.", data: { outcome: "not_waiting", ...flag(true) } };
    return { text: "Agent is still working. Tell the user and offer to check later; do not poll.", data: { outcome: "still_working", ...flag(true) } };
  }

  async function startChat(_url, { project, prompt, model, thinking, mode, waitSeconds } = {}) {
    const picked = pickProject(project);
    if (picked.ask) {
      log("startChat", { project, prompt, model, thinking, mode, waitSeconds }, "needs_clarification");
      return picked.ask;
    }
    let outcome = takeOutcome("start_chat");
    if (outcome === "still_working" && waitSeconds === 0) outcome = "not_waiting";
    log("startChat", { project, prompt, model, thinking, mode, waitSeconds }, outcome);
    fail(outcome);
    state.created += 1;
    const id = state.created === 1 ? NEW_CHAT_ID : `${NEW_CHAT_ID.slice(0, 35)}${state.created}`;
    const result = outcomeOf(outcome);
    world.chats.push({
      id,
      title: truncate(prompt, 60),
      project: picked.project.name,
      workspace: null,
      status: result.data.outcome === "still_working" ? "running" : "idle",
      attention: result.data.outcome === "replied" ? "finished" : null,
      permissions: [],
      archived: false,
      subagents: [],
      updatedAt: new Date(now).toISOString(),
      createdAt: new Date(now).toISOString(),
      turns: [{ at: new Date(now).toISOString(), end: null, user: prompt, agent: result.data.reply ? [result.data.reply] : [], calls: [] }],
    });
    return { text: `Started a new chat in ${picked.project.name}; the task arrived.\n${result.text}`, data: { chat_id: id, short_id: id.slice(0, 7), project: picked.project.name, ...result.data } };
  }

  async function sendMessage(_url, { chat, text: message, ifBusy, waitSeconds } = {}) {
    const args = { chat, text: message, ifBusy, waitSeconds };
    const picked = pickChat(chat);
    if (picked.ask) {
      log("sendMessage", args, "needs_clarification");
      return picked.ask;
    }
    const target = picked.chat;
    const ids = { chat_id: target.id, short_id: target.id.slice(0, 7), project: target.project };
    if (isRunning(target) && !ifBusy) {
      log("sendMessage", args, "busy");
      return {
        text: `Not sent: ${truncate(target.title, 70)} is busy. Ask the user whether to add this to its current work or interrupt it, then call again with if_busy.`,
        data: { ...ids, outcome: "busy", ...flag(false) },
      };
    }
    let outcome = takeOutcome("send_message");
    if (outcome === "auto") outcome = waitSeconds === 0 ? "not_waiting" : "still_working";
    log("sendMessage", args, outcome);
    fail(outcome);
    const result = outcomeOf(outcome);
    target.turns.push({ at: new Date(now).toISOString(), end: null, user: message, agent: result.data.reply ? [result.data.reply] : [], calls: [] });
    target.status = result.data.outcome === "still_working" ? "running" : "idle";
    target.attention = result.data.outcome === "replied" ? "finished" : null;
    target.updatedAt = new Date(now).toISOString();
    return { text: `Sent to ${truncate(target.title, 70)}; it arrived.\n${result.text}`, data: { chat_id: target.id, short_id: target.id.slice(0, 7), project: target.project, ...result.data } };
  }

  async function answerApproval(_url, { chat, decision, request } = {}) {
    const outcome = takeOutcome("answer_approval");
    log("answerApproval", { chat, decision, request }, outcome);
    const picked = pickChat(chat);
    if (picked.ask) return picked.ask;
    const target = picked.chat;
    if (target.permissions.length === 0) {
      return {
        text: `${chatLine(target, now)}\nNothing is waiting for approval here, so nothing was allowed or denied. If the agent asked the user a question in its text, answer it with send_message.`,
        data: { chat_id: target.id, done: false, what: null },
      };
    }
    fail(outcome);
    const what = describePermission(target.permissions[0]);
    target.permissions = [];
    target.attention = null;
    target.status = decision === "allow" ? "running" : "idle";
    const behavior = decision === "allow" ? "allow" : "deny";
    return { text: `${behavior === "allow" ? "Allowed" : "Denied"}: ${what} in ${truncate(target.title, 70)}.`, data: { chat_id: target.id, done: true, decision: behavior, what } };
  }

  async function stopChat(_url, { chat } = {}) {
    const outcome = takeOutcome("stop_chat");
    log("stopChat", { chat }, outcome);
    const picked = pickChat(chat);
    if (picked.ask) return picked.ask;
    const target = picked.chat;
    if (!isRunning(target)) return { text: `${chatLine(target, now)}\nIt is not running; nothing was stopped.`, data: { chat_id: target.id, done: false } };
    fail(outcome);
    const before = chatState(target);
    target.status = "idle";
    return { text: `Stopped ${truncate(target.title, 70)}. State before: ${before}.`, data: { chat_id: target.id, done: true } };
  }

  async function releaseStatus(_url, { siteVersion: version = siteVersion, build = null } = {}) {
    log("releaseStatus", {});
    const data = releaseData(release, version, build);
    return { text: describeRelease(data, now), data };
  }

  async function releaseStart(_url, { action } = {}) {
    const outcome = takeOutcome("update_site");
    log("releaseStart", { action }, outcome);
    fail(outcome);
    const what = action === "rollback" ? "rollback" : "update";
    return {
      text: `Started the ${what} on the Mac. It takes a few minutes and puts the previous version back by itself if the new one fails its check; ask for the update status any time.`,
      data: { started: true, action, job_id: "job-eval-1", message: `${what} started` },
    };
  }

  return {
    state,
    ops: { overview, listChats, readChat, readActivity, showImages, searchMessages, startChat, sendMessage, answerApproval, stopChat, releaseStatus, releaseStart },
  };
}
