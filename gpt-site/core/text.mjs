// Pure helpers for the Paseo operations: matching spoken names, and the
// compact text ChatGPT reads and often speaks back. No I/O here, so all of it
// is unit-tested in core/text.test.mjs.

export function normalize(value) {
  return String(value ?? "")
    .toLowerCase()
    .replaceAll("ё", "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function words(value) {
  return normalize(value).split(" ").filter(Boolean);
}

// Russian inflects word endings ("флот", "флота", "флоту"), so two words count
// as the same when one is a prefix of the other or they share four letters.
// Single letters ("этап D") only match themselves.
function sameWord(a, b) {
  if (a === b) {
    return true;
  }
  if (a.startsWith(b) || b.startsWith(a)) {
    return Math.min(a.length, b.length) >= 2;
  }
  let shared = 0;
  while (shared < a.length && shared < b.length && a[shared] === b[shared]) {
    shared += 1;
  }
  return shared >= 4;
}

function overlap(queryWords, text) {
  const textWords = words(text);
  const hits = queryWords.filter((q) => textWords.some((t) => sameWord(q, t)));
  return hits.length / queryWords.length;
}

// Finds what a spoken or typed reference points at. Items must already be in
// recency order, which breaks ties. Order of precedence: an id or an id prefix
// of 6+ characters (the "#a1b2c3d" form), an exact name, then the best word
// overlap. Returns { match } when there is one clear answer, otherwise
// { candidates } with up to three names to ask about.
export function resolve(items, query, { id = (x) => x.id, text = (x) => x.name } = {}) {
  const raw = String(query ?? "").trim().replace(/^#/, "").toLowerCase();
  if (!raw) {
    return { candidates: [] };
  }
  const byId = items.find((x) => id(x) === raw || (raw.length >= 6 && id(x).startsWith(raw)));
  if (byId) {
    return { match: byId };
  }
  const exact = items.filter((x) => normalize(text(x)) === normalize(raw));
  if (exact.length === 1) {
    return { match: exact[0] };
  }
  const queryWords = words(raw);
  if (queryWords.length === 0) {
    return { candidates: [] };
  }
  const scored = items
    .map((item) => ({ item, score: overlap(queryWords, text(item)) }))
    .filter((s) => s.score > 0);
  const best = Math.max(0, ...scored.map((s) => s.score));
  const top = scored.filter((s) => s.score === best);
  if (top.length === 1 && best >= 0.5) {
    return { match: top[0].item };
  }
  const candidates = scored.sort((a, b) => b.score - a.score).slice(0, 3).map((s) => s.item);
  // `top` keeps every best-scoring item, beyond the three offered to the user.
  return scored.length ? { candidates, top: top.map((s) => s.item) } : { candidates };
}

// For reads: of the chats a reference could mean ("the agent in jobby"), the one with something
// going on — running, waiting for an approval, or with subagents at work. Null unless exactly one.
export function pickActive(chats) {
  const active = chats.filter((c) => ["running", "initializing"].includes(c.status) || c.permissions.length > 0 || c.subagentsRunning > 0);
  return active.length === 1 ? active[0] : null;
}

// ---- Which chat a name means --------------------------------------------------------------------
// Paseo titles a new chat with the first line of its first message, cut to 60 characters
// (create-agent-title.js in @getpaseo/server): a chat that continues another one usually starts the
// same way and gets the same title, and a long title stops mid-word. Paseo also has a model name each
// chat's workspace, and that title (what its sidebar shows) often tells such chats apart.
const TITLE_CUT = 60;

// A chat's whole names, normalized: its title and its workspace's own title, each alone and with
// the project after it, the way chat lines show them ("Fleet map (proxy)").
function wholeNames(chat) {
  const title = normalize(chat.title);
  const project = normalize(chat.project);
  const workspace = normalize(chat.workspace);
  const names = [title];
  if (workspace && workspace !== project && workspace !== title) names.push(workspace);
  return [...names, ...names.map((name) => `${name} ${project}`)];
}

// A title Paseo cut short is named by a query that goes on from it: "…в тестовом аккаунте" names the
// chat titled "…в тестовом а".
function goesOnFrom(chat, query) {
  const title = normalize(chat.title);
  return title !== "" && String(chat.title).trim().length >= TITLE_CUT - 1 && query.startsWith(title);
}

// The share of the query's words found among the chat's title, workspace and project words.
function coverage(queryWords, chat) {
  const names = words(`${chat.title} ${chat.workspace ?? ""} ${chat.project}`);
  return queryWords.filter((q) => names.some((t) => sameWord(q, t))).length / queryWords.length;
}

// Which chats a name points at, by tier: "exact" (one of their whole names, or a cut title the name
// goes on from), "words" (every word of the name is among theirs) or "partial" (at least half of
// them). `best` holds every chat of the tier at its top score, in the order given (newest first);
// `near`, for partial matches and below, every chat with a word in common, closest first. Ids are
// not names: the caller looks them up.
export function matchChat(chats, query) {
  const q = normalize(query);
  if (!q) return { tier: null, best: [], near: [] };
  for (const named of [(c) => wholeNames(c).includes(q), (c) => goesOnFrom(c, q)]) {
    const best = chats.filter(named);
    if (best.length) return { tier: "exact", best };
  }
  const queryWords = words(q);
  const scored = chats.map((chat) => ({ chat, score: coverage(queryWords, chat) })).filter((s) => s.score > 0);
  const top = Math.max(0, ...scored.map((s) => s.score));
  const best = scored.filter((s) => s.score === top).map((s) => s.chat);
  if (top === 1) return { tier: "words", best };
  // A stable sort: among equals the newest stays first.
  const near = [...scored].sort((a, b) => b.score - a.score).map((s) => s.chat);
  return top >= 0.5 ? { tier: "partial", best, near } : { tier: null, best: [], near };
}

// Settles a name among active chats. The one chat at the top is the answer, except that a write
// never takes a partial match (a word the user said fits no chat) and never chooses between equals,
// by recency or by state. A read also takes the closest match and, among equals, the only one with
// something going on, saying so in `note`. Otherwise { ask: reason, chats } with the ones to offer.
export function settleChat(chats, query, { read = false } = {}) {
  const found = matchChat(chats, query);
  if (!found.tier) return { ask: "no_match", chats: found.near };
  if (found.best.length === 1 && (read || found.tier !== "partial")) return { chat: found.best[0] };
  if (read) {
    const one = pickActive(found.best);
    if (one) return { chat: one, note: `"${query}" matches ${found.best.length} chats; this is the only active one.` };
  }
  if (found.tier === "partial" && !read) return { ask: "partial", chats: found.near };
  return { ask: found.tier === "exact" ? "same_name" : "similar", chats: found.best };
}

// A chat among others the user picks from: its chat line, with its workspace's title where that
// tells it apart, since such chats often share a title.
export function choiceLine(chat, now = Date.now()) {
  const workspace = String(chat.workspace ?? "").trim();
  const tells = workspace !== "" && ![normalize(chat.title), normalize(chat.project)].includes(normalize(workspace));
  const where = tells ? `${chat.project}, workspace "${truncate(workspace, 70)}"` : chat.project;
  return `${truncate(chat.title, 70)} (${where}): ${chatState(chat)}${chat.archived ? ", archived" : ""}, ${ago(chat.updatedAt, now)}`;
}

const CHOICES_SHOWN = 5;

const CHAT_QUESTIONS = {
  same_name: (q, n) => `${n} chats are named "${q}"`,
  similar: (q, n) => `"${q}" fits ${n} chats equally`,
  partial: (q) => `No chat has every word of "${q}"`,
  id_prefix: (q) => `Several chats have an id starting with "${q}"`,
  no_match: (q) => `No active chat matches "${q}"`,
  unknown_id: (q) => `No chat has the id "${q}"`,
};

// Names are matched among active chats only; the archive is the user's to ask for.
const ARCHIVE_UNSEARCHED = "Archived chats were not searched: look there (list_chats with include_archived) only if the user asks.";

const CHAT_QUESTION_NOTES = {
  same_name: "Chats often share a title: Paseo titles each with the start of its first message.",
  partial: "The closest:",
  no_match: `${ARCHIVE_UNSEARCHED} The closest active ones:`,
};

// needs_clarification for a chat reference: why it did not settle (reason) and the chats to pick
// from, which the text tells apart without ids. `read` false: a write, so the text says nothing was
// done. What the model does next: take the one the conversation is about, by its id, or ask.
export function chatQuestion(query, reason, chats, { read = false, now = Date.now() } = {}) {
  const shown = chats.slice(0, CHOICES_SHOWN);
  const head = `${CHAT_QUESTIONS[reason](query, chats.length)}${read ? "" : ", so nothing was done"}.`;
  const lines = shown.length
    ? [
        CHAT_QUESTION_NOTES[reason],
        'Ask the user which one, naming what tells them apart. Pick one yourself (call again with its id) only if the user\'s words pick it ("the latest" is the one updated most recently; "the one about X" is the one whose title or workspace says X) or this conversation already read or used exactly that chat. Words they all share, or coming first, are no reason to pick:',
        ...shown.map((c) => `- ${choiceLine(c, now)}`),
        chats.length > shown.length ? `… and ${chats.length - shown.length} more; a fuller name narrows it down.` : null,
      ]
    : [
        {
          unknown_id: "It was deleted, or the id is wrong: use the chat's name, or find it with list_chats.",
          id_prefix: "Pass the whole id, or the chat's name.",
        }[reason] ?? `${ARCHIVE_UNSEARCHED} Otherwise ask the user for another name.`,
      ];
  return {
    text: [head, ...lines].filter(Boolean).join("\n"),
    data: { needs_clarification: { kind: "chat", query: String(query ?? ""), reason, candidates: shown.map((c) => chatData(c, now)) } },
  };
}

// A cut at `at` (a UTF-16 index) moved off the middle of a surrogate pair, so an emoji is never split.
function pairSafe(text, at) {
  const code = text.charCodeAt(at);
  return at > 0 && code >= 0xdc00 && code <= 0xdfff ? at - 1 : at;
}

// Cuts at a line or sentence end when one is in the second half, else at a word
// boundary, so speech does not stop mid-word. `max` counts characters.
export function truncate(value, max) {
  const text = String(value ?? "").trim();
  if (text.length <= max) {
    return text;
  }
  const head = text.slice(0, pairSafe(text, max));
  const sentence = Math.max(head.lastIndexOf("\n"), head.lastIndexOf(". "));
  const space = head.lastIndexOf(" ");
  const cut = sentence > max / 2 ? sentence + 1 : space > max / 2 ? space : head.length;
  return `${head.slice(0, cut).trimEnd()} …`;
}

// A turn's visible text: the final message matters most, so messages are kept
// from the last one backwards while they fit, and an earlier cut is marked.
// Empty messages (a cancelled turn leaves one) are skipped.
export function latestFirstWithin(messages, max) {
  const texts = messages.map((m) => String(m ?? "").trim()).filter(Boolean);
  const kept = [];
  let used = 0;
  for (let i = texts.length - 1; i >= 0; i -= 1) {
    if (used + texts[i].length > max) {
      if (kept.length === 0) kept.push(truncate(texts[i], max));
      break;
    }
    kept.unshift(texts[i]);
    used += texts[i].length + 2;
  }
  const omitted = texts.length - kept.length;
  return [omitted > 0 ? `(${omitted} earlier message(s) omitted)` : null, ...kept].filter(Boolean).join("\n\n");
}

// Paseo stores ISO 8601 UTC; this keeps every timestamp in one explicit form.
export function toIso(value) {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

// A short excerpt around the first place the query occurs: the whole phrase
// if present, else its longest word. Falls back to the start of the text.
export function snippet(text, query, radius = 80) {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  const haystack = flat.toLowerCase().replaceAll("ё", "е");
  const phrase = String(query ?? "").toLowerCase().replaceAll("ё", "е").trim();
  const longest = words(phrase).sort((a, b) => b.length - a.length)[0] ?? "";
  let at = phrase ? haystack.indexOf(phrase) : -1;
  let length = phrase.length;
  if (at < 0 && longest.length >= 3) {
    at = haystack.indexOf(longest);
    length = longest.length;
  }
  if (at < 0) return truncate(flat, radius * 2);
  const start = pairSafe(flat, Math.max(0, at - radius));
  const end = pairSafe(flat, Math.min(flat.length, at + length + radius));
  return `${start > 0 ? "…" : ""}${flat.slice(start, end).trim()}${end < flat.length ? "…" : ""}`;
}

// The structured form of a chat, alongside its text line.
export function chatData(chat, now = Date.now()) {
  const context = contextOf(chat.usage);
  return {
    id: chat.id,
    short_id: chat.id.slice(0, 7),
    title: chat.title,
    project: chat.project,
    workspace: chat.workspace ?? null,
    status: chat.status,
    state: chatState(chat),
    pending_approvals: chat.permissions.map((p) => describePermission(p)),
    updated_at: toIso(chat.updatedAt),
    updated_ago: chat.updatedAt ? ago(chat.updatedAt, now) : null,
    created_at: toIso(chat.createdAt),
    archived: Boolean(chat.archived),
    // Where it sits and what it runs on, so the next call can name its workspace or change its model.
    ...(chat.workspaceId ? { workspace_id: chat.workspaceId } : {}),
    ...(chat.provider ? { provider: chat.provider } : {}),
    ...(chat.model ? { model: chat.model } : {}),
    ...(chat.thinking ? { thinking: chat.thinking } : {}),
    ...(chat.subagentsRunning !== undefined ? { subagents_running: chat.subagentsRunning } : {}),
    ...(context ? { context } : {}),
  };
}

// How full the agent's context window is, from Paseo's lastUsage: the numbers its own context meter
// shows. Paseo keeps them in memory only, so after a daemon restart they are unknown (null) until
// the agent's next turn.
export function contextOf(usage) {
  const used = usage?.contextWindowUsedTokens;
  const max = usage?.contextWindowMaxTokens;
  if (!Number.isFinite(used) || !Number.isFinite(max) || used < 0 || max <= 0) return null;
  return { used_tokens: used, max_tokens: max, percent_used: Math.round((used / max) * 100), remaining_tokens: Math.max(0, max - used) };
}

// 59606 → "60k", 1000000 → "1M".
function tokenCount(n) {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${Number((n / 1_000_000).toFixed(1))}M`;
}

// A chat's context (chatData's context field) in words, or null when Paseo does not know it.
export function contextLine(context) {
  if (!context) return null;
  return `Context window: ${context.percent_used}% used (${tokenCount(context.used_tokens)} of ${tokenCount(context.max_tokens)} tokens).`;
}

// update_status: the plugin's release status (null when the Mac is unreachable) next to the
// version this Site was built from.
export function releaseData(status, siteVersion, build = null) {
  const job = status?.job ?? null;
  return {
    site_version: siteVersion,
    build,
    installed_version: status?.installed ?? null,
    update_available: status ? status.installed !== siteVersion : null,
    latest_release: status?.latest?.version ?? null,
    latest_is_newer: status?.latest ? Boolean(status.latest.newer) : null,
    live_release: status?.live?.versionNumber ?? null,
    mac_online: Boolean(status),
    ...(job
      ? {
          job: {
            action: job.action,
            state: job.state,
            step: job.step,
            started_at: job.startedAt,
            finished_at: job.finishedAt,
            message: job.result?.message ?? null,
            error: job.error ? job.error.split("\n")[0] : null,
          },
        }
      : {}),
  };
}

const JOB_NAMES = { update: "update", rollback: "rollback", configure: "settings update" };

export function describeRelease(data, now = Date.now()) {
  if (!data.mac_online) {
    return `God Mode ${data.site_version} is live. The Mac is offline, so updates cannot be checked or started right now.`;
  }
  const job = data.job;
  const what = JOB_NAMES[job?.action] ?? "update";
  if (job?.state === "running") return `The ${what} is running: ${job.step}, started ${ago(job.started_at, now)}.`;
  const lines = [
    data.update_available
      ? `God Mode ${data.site_version} is live; the Mac has ${data.installed_version}, so an update is available.`
      : `God Mode ${data.site_version} is live and up to date with the Mac.`,
  ];
  if (data.latest_is_newer) lines.push(`Version ${data.latest_release} is out on GitHub; update the God Mode plugin in Paseo to get it.`);
  if (job?.state === "succeeded") lines.push(`The last ${what} succeeded${job.message ? `: ${job.message}` : "."}`);
  else if (job) lines.push(`The last ${what} ${job.state === "interrupted" ? "was interrupted" : "failed"}${job.error ? `: ${job.error}` : "."}`);
  return lines.join(" ");
}

export function ago(iso, now = Date.now()) {
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

// A pending permission request in words a listener understands: the plan's
// title, the command, the file, rather than the tool's internal name.
export function describePermission(permission, max = 120) {
  const detail = permission.detail ?? {};
  // Questions the agent asks the user (Claude's AskUserQuestion, Codex's questions): by their
  // headers, or the one question whole.
  const questions = permission.kind === "question" && Array.isArray(permission.input?.questions) ? permission.input.questions : [];
  if (questions.length === 1 && typeof questions[0]?.question === "string") {
    return truncate([questions[0].header, questions[0].question].filter((s) => typeof s === "string" && s.trim()).join(": "), max);
  }
  if (questions.length > 1) {
    const headers = questions.map((q) => (typeof q?.header === "string" ? q.header.trim() : "")).filter(Boolean);
    return truncate(`${questions.length} questions${headers.length ? `: ${headers.join(", ")}` : ""}`, max);
  }
  if (permission.kind === "plan" && typeof permission.input?.plan === "string") {
    const heading = permission.input.plan.split("\n").find((line) => line.trim()) ?? "";
    return truncate(`plan: ${heading.replace(/^#+\s*(plan:\s*)?/i, "")}`, max);
  }
  if (detail.type === "shell") return truncate(`run: ${detail.command}`, max);
  if (detail.type === "edit" || detail.type === "write") return truncate(`${detail.type} ${detail.filePath}`, max);
  if (detail.type === "fetch") return truncate(`fetch ${detail.url}`, max);
  return truncate(permission.title ?? permission.description ?? permission.name, max);
}

// What a chat is doing, from the user's point of view. subagentsRunning is known only where the
// caller asked the daemon (overview, read_activity).
export function chatState(chat) {
  if (chat.permissions.length > 0) {
    const what = chat.permissions[0].kind === "question" ? "an answer" : "approval";
    return `waiting for ${what}: ${describePermission(chat.permissions[0], 80)}`;
  }
  const helpers = chat.subagentsRunning > 0 ? `${chat.subagentsRunning} subagent(s) working` : null;
  if (chat.status === "running" || chat.status === "initializing") return helpers ? `running, ${helpers}` : "running";
  if (helpers) return helpers;
  if (chat.status === "error" || chat.attention === "error") return "error";
  if (chat.attention === "finished") return "new reply";
  return "idle";
}

// A chat in words to be spoken: title, project, state, age. Ids stay in the structured data.
export function chatLine(chat, now = Date.now()) {
  const archived = chat.archived ? ", archived" : "";
  return `${truncate(chat.title, 70)} (${chat.project}): ${chatState(chat)}${archived}, ${ago(chat.updatedAt, now)}`;
}

// The structured form of one tool call. With where it starts in the timeline (`seq`) it also says
// whether `text` is all of it and gives the id read_message reads the whole of it by.
export function toolCallData(item, max, seq) {
  const text = describeToolCall(item, max);
  const whole = callText(item);
  // Whitespace the cut trimmed is not content.
  const flat = (s) => s.replace(/\s+/g, " ").trim();
  // A subagent's call is Paseo's id for the subagent: its final message is read by it, from any turn.
  const subagent = item.detail?.type === "sub_agent" && item.callId ? subagentRef(item.callId) : null;
  return {
    kind: item.detail?.type ?? "tool",
    name: item.name,
    status: item.status,
    text: subagent ? `${text} (its final message: read_message ${subagent})` : text,
    ...(seq === undefined ? {} : { id: messageRef("call", seq), chars: charCount(whole), truncated: flat(text) !== flat(whole) }),
    ...(subagent ? { result_id: subagent } : {}),
  };
}

export function candidatesText(kind, query, candidates) {
  if (candidates.length === 0) {
    return `No ${kind} matches "${query}". Ask the user for another name.`;
  }
  return [
    `Several ${kind}s could match "${query}". Ask the user which one, then call again with the one they mean:`,
    ...candidates.map((c) => `- ${c}`),
  ].join("\n");
}

// ---- Pinned chats -------------------------------------------------------------------------------
// Paseo pins a workspace, not a chat: the rows of the Pinned section at the top of its sidebar. A row
// shows its workspace's title (else its branch or folder) and usually holds one chat, sometimes none
// (its only chat was archived, or it holds only terminals) or several.

// The words a pinned row can be named by: its name, branch and project, and its chats' titles.
const pinnedWords = (row) => `${row.name} ${row.branch ?? ""} ${row.project} ${row.chats.map((c) => c.title).join(" ")}`;

// The rows a query names: those with every word of it, else those with at least half (closest first),
// else every row, so the model can match words the user said in another language or spelling
// ("миникуб" for Minikube) itself. match is null without a query.
export function matchPinned(rows, query) {
  const queryWords = words(query);
  if (queryWords.length === 0) return { match: null, rows };
  const scored = rows.map((row) => ({ row, score: overlap(queryWords, pinnedWords(row)) }));
  const every = scored.filter((s) => s.score === 1).map((s) => s.row);
  if (every.length) return { match: "all_words", rows: every };
  // A stable sort: among equals the latest pin stays first.
  const some = scored.filter((s) => s.score >= 0.5).sort((a, b) => b.score - a.score).map((s) => s.row);
  if (some.length) return { match: "some_words", rows: some };
  return { match: "none", rows };
}

// The structured form of a pinned row; its chats come as chatData.
export function pinnedData(row, now = Date.now()) {
  return {
    workspace_id: row.id,
    name: row.name,
    project: row.project,
    branch: row.branch ?? null,
    pinned_at: toIso(row.pinnedAt),
    pinned_ago: row.pinnedAt ? ago(row.pinnedAt, now) : null,
    status: row.status,
    chats: row.chats.map((c) => chatData(c, now)),
  };
}

// A pinned row in words: its name as the sidebar shows it, its project, and what its chats do.
export function pinnedLine(row, now = Date.now()) {
  const head = `${truncate(row.name, 70)} (${row.project})`;
  if (row.chats.length === 0) return `${head}: no active chat`;
  if (row.chats.length === 1) return `${head}: ${chatState(row.chats[0])}, ${ago(row.chats[0].updatedAt, now)}`;
  return `${head}: ${row.chats.length} chats: ${row.chats.map((c) => `${truncate(c.title, 50)}, ${chatState(c)}, ${ago(c.updatedAt, now)}`).join("; ")}`;
}

// list_pinned_chats' answer over the pinned rows of its scope (a project, or "all projects"), latest
// pin first, picked among by the query's words.
export function pinnedResult(rows, { scope, query, now = Date.now() }) {
  const found = matchPinned(rows, query);
  const data = {
    scope,
    query: query ?? null,
    ...(found.match ? { query_match: found.match } : {}),
    total: found.rows.length,
    pinned: found.rows.map((row) => pinnedData(row, now)),
  };
  const where = scope === "all projects" ? "" : ` in ${scope}`;
  if (rows.length === 0) return { text: `Nothing is pinned${where}.`, data };
  const n = found.rows.length;
  const head = {
    all_words: `${n} pinned${where} match "${query}":`,
    some_words: `No pinned chat${where} has every word of "${query}"; the closest ${n}:`,
    none: `No pinned chat${where} has the words of "${query}". All ${n} pinned${where}, latest pin first; the user may have said a name in another language or spelling:`,
  }[found.match] ?? `${n} pinned${where}, latest pin first:`;
  const hint = "The data carries each chat's id: pass it to the next tool. If the user meant one and several fit, ask which.";
  return { text: [head, ...found.rows.map((row) => pinnedLine(row, now)), hint].join("\n"), data };
}

// The sidebar row a name reaches for pin_chat when it settles on no one chat (reason, as the chat
// question gives it), or null. A row's title is a whole name of each chat in it, so a name that only
// the chats of one row have names that row, and pinning acts on the row: no choice between them is
// needed. A name no chat has whole may name a row with no active chat (its chat was archived, or it
// holds only terminals), which no chat's name reaches: the one such row with every word of it.
export function pinRowFor(rows, chats, query, reason) {
  if (reason === "same_name" || reason === "similar") {
    const ids = settleChat(chats, query).chats.map((c) => c.id);
    const holding = rows.filter((row) => row.chats.some((c) => ids.includes(c.id)));
    return holding.length === 1 && ids.every((id) => holding[0].chats.some((c) => c.id === id)) ? holding[0] : null;
  }
  if (reason === "no_match" || reason === "partial") {
    const found = matchPinned(rows.filter((row) => row.chats.length === 0), query);
    return found.match === "all_words" && found.rows.length === 1 ? found.rows[0] : null;
  }
  return null;
}

const PIN_DONE = new Set(["pinned", "unpinned"]);

// pin_chat's answer. Paseo pins a row (a workspace with its active chats), so a chat's pin carries
// the other chats of its row along. chat is the chat the user named, if they named one; row is null
// when the chat has no row to pin: it is archived, or Paseo shows no row for it.
export function pinResult({ action, outcome, row = null, chat = null, now = Date.now() }) {
  const named = chat ? `${truncate(chat.title, 70)} (${chat.project})` : `${truncate(row.name, 70)} (${row.project})`;
  // The row's own name, where it is not the chat's title: what the sidebar shows.
  const rowName = row && chat && ![normalize(chat.title), normalize(chat.project)].includes(normalize(row.name)) ? ` "${truncate(row.name, 70)}"` : "";
  const others = row ? row.chats.filter((c) => c.id !== chat?.id) : [];
  const titles = others.map((c) => truncate(c.title, 70)).join("; ");
  let holds = "";
  if (row && chat && others.length) holds = ` Paseo pins the whole row, so ${others.length === 1 ? "its other chat goes" : `its ${others.length} other chats go`} with it: ${titles}.`;
  if (row && !chat) holds = others.length ? ` The row holds: ${titles}.` : " The row holds no active chat.";
  const text = {
    pinned: `Pinned ${named}: its row${rowName} is in the Pinned section at the top of Paseo's sidebar now.${holds}`,
    unpinned: `Unpinned ${named}: its row${rowName} left the Pinned section of Paseo's sidebar.${holds}`,
    already_pinned: `${named} is already pinned, since ${ago(row?.pinnedAt, now)}; nothing changed.`,
    not_pinned: `${named} is not pinned; nothing changed.`,
    archived: `Nothing changed: ${named} is archived, so it is not in Paseo's sidebar.${action === "unpin" ? " If a pinned row is left from it, list_pinned_chats gives that row's workspace_id to unpin it." : ""}`,
    no_row: `Nothing changed: Paseo's sidebar shows no row for ${named}.`,
  }[outcome];
  return {
    text,
    data: {
      ...(chat ? { chat_id: chat.id, short_id: chat.id.slice(0, 7) } : {}),
      ...(row ? { workspace_id: row.id, name: row.name } : {}),
      project: row?.project ?? chat.project,
      action,
      outcome,
      done: PIN_DONE.has(outcome),
      ...(row ? { pinned_at: toIso(row.pinnedAt), chats: row.chats.map((c) => chatData(c, now)) } : {}),
    },
  };
}

// pin_chat's answer to a workspace_id that names no row of Paseo's sidebar.
export function rowQuestion(workspaceId) {
  return {
    text: `No row of Paseo's sidebar has the workspace id "${workspaceId}", so nothing was done. It may have been archived; list_pinned_chats gives each pinned row's workspace_id.`,
    data: { needs_clarification: { kind: "workspace", query: String(workspaceId ?? ""), candidates: [] } },
  };
}

// ---- Which workspace a name means ---------------------------------------------------------------
// start_chat can open a chat in a workspace that already exists, as another tab of its row in Paseo's
// sidebar. A row is named by its title (else its branch or folder) or by the title of a chat in it, each
// alone or with the project after it. As with a chat, one row must have the whole name or every word of
// it: a partial match is never taken, and neither is a choice between equals.

function rowNames(row) {
  const project = normalize(row.project);
  const names = [row.name, ...row.chats.map((c) => c.title)].map(normalize).filter(Boolean);
  return [...names, ...names.map((name) => `${name} ${project}`)];
}

// Settles a name among the rows. { row }, or { ask: reason, rows } with the rows to offer, reason as the
// chat questions give it.
export function settleRow(rows, query) {
  const q = normalize(query);
  if (!q) return { ask: "no_match", rows };
  const exact = rows.filter((row) => rowNames(row).includes(q));
  if (exact.length) return exact.length === 1 ? { row: exact[0] } : { ask: "same_name", rows: exact };
  const found = matchPinned(rows, query);
  if (found.match === "all_words") return found.rows.length === 1 ? { row: found.rows[0] } : { ask: "similar", rows: found.rows };
  return { ask: found.match === "some_words" ? "partial" : "no_match", rows: found.match === "some_words" ? found.rows : rows };
}

const ROW_QUESTIONS = {
  same_name: (q, n) => `${n} workspaces are named "${q}"`,
  similar: (q, n) => `"${q}" fits ${n} workspaces equally`,
  partial: (q) => `No workspace has every word of "${q}"`,
  no_match: (q) => `No workspace matches "${q}"`,
};

const latestChat = (row) => Math.max(0, ...row.chats.map((c) => Date.parse(c.updatedAt) || 0));

// What the question about a workspace says was not done, and what else there is to offer when no row fits.
const ROW_TOOLS = {
  start_chat: { undone: "no chat was started", orElse: "Ask which one, or start the chat in the project alone, which gives it a workspace of its own:" },
  rename_workspace: { undone: "nothing was renamed", orElse: "Ask which one:" },
};

// needs_clarification for the workspace a tool was asked to act on: nothing was done.
// The rows to pick from come newest first, told apart by their chats.
export function rowsQuestion(query, reason, rows, { now = Date.now(), tool = "start_chat" } = {}) {
  const shown = [...rows].sort((a, b) => latestChat(b) - latestChat(a)).slice(0, CHOICES_SHOWN);
  const ask =
    reason === "no_match"
      ? `The most recent workspaces follow; the user may have said a name in another language or spelling. ${ROW_TOOLS[tool].orElse}`
      : 'Ask the user which one, naming what tells them apart. Pick one yourself (call again with its workspace_id) only if the user\'s words pick it or this conversation already used exactly that workspace:';
  return {
    text: [
      `${ROW_QUESTIONS[reason](query, rows.length)}, so ${ROW_TOOLS[tool].undone}.`,
      ask,
      ...shown.map((row) => `- ${pinnedLine(row, now)}`),
      rows.length > shown.length && reason !== "no_match" ? `… and ${rows.length - shown.length} more; a fuller name narrows it down.` : null,
    ]
      .filter(Boolean)
      .join("\n"),
    data: { needs_clarification: { kind: "workspace", query: String(query ?? ""), reason, candidates: shown.map((row) => pinnedData(row, now)) } },
  };
}

// ---- Renames ----------------------------------------------------------------------------------
// rename_chat and rename_workspace answer with what Paseo itself shows: old_name read before the
// request and new_name read back after it. new_name exists only when Paseo shows the name asked for;
// otherwise current_name says what it shows instead, if it could be read at all.

function renameFields({ outcome, oldName, shown, error }) {
  const confirmed = outcome === "renamed" || outcome === "unchanged";
  return {
    outcome,
    done: outcome === "renamed",
    old_name: oldName,
    ...(confirmed ? { new_name: shown } : {}),
    ...(outcome === "error" && shown !== null ? { current_name: shown } : {}),
    ...(error ? { error } : {}),
  };
}

const renameFailure = (error, shown) => (shown === null ? `Not confirmed: ${error}. Whether it took effect is unknown: never say it did.` : `Not renamed: ${error}. Paseo shows "${truncate(shown, 70)}" now.`);

// rename_chat's answer. shown is the name Paseo shows after the request, null when it could not be read.
export function chatRenameResult({ outcome, chat, name, shown = chat.title, error = null }) {
  const old = truncate(chat.title, 70);
  const row = chat.workspace && chat.workspace !== name ? ` Its row in the sidebar keeps the name "${truncate(chat.workspace, 70)}": that is the workspace's name, and rename_workspace changes it.` : "";
  const text = {
    renamed: `Renamed the chat "${old}" to "${truncate(shown, 70)}" (${chat.project}). Paseo shows the new name now.${row}`,
    unchanged: `The chat is already named "${old}" (${chat.project}); nothing changed.`,
    archived: `Nothing changed: "${old}" (${chat.project}) is archived. Tell the user.`,
    error: renameFailure(error, shown),
  }[outcome];
  return {
    text,
    data: {
      chat_id: chat.id,
      short_id: chat.id.slice(0, 7),
      project: chat.project,
      ...(chat.workspaceId ? { workspace_id: chat.workspaceId } : {}),
      ...(chat.workspace ? { workspace: chat.workspace } : {}),
      ...renameFields({ outcome, oldName: chat.title, shown, error }),
    },
  };
}

// rename_workspace's answer. after is the row as Paseo shows it after the request, null when it could
// not be read. Its pin and its chats come from that same reading.
export function workspaceRenameResult({ outcome, row, name, after = null, error = null, now = Date.now() }) {
  const old = truncate(row.name, 70);
  const shown = after?.name ?? null;
  const kept = [
    row.pinnedAt && after?.pinnedAt ? " It stays pinned, and the Pinned section shows the new name." : "",
    after?.chats.length === 1 ? " Its chat keeps its own name." : "",
    after?.chats.length > 1 ? ` Its ${after.chats.length} chats keep their own names.` : "",
  ].join("");
  const text = {
    renamed: `Renamed the workspace "${old}" to "${truncate(name, 70)}" (${row.project}). Paseo's sidebar shows the new name now.${kept}`,
    unchanged: `The workspace is already named "${old}" (${row.project}); nothing changed.`,
    error: renameFailure(error, shown),
  }[outcome];
  return {
    text,
    data: {
      workspace_id: row.id,
      project: row.project,
      ...renameFields({ outcome, oldName: row.name, shown, error }),
      ...(after ? { pinned: Boolean(after.pinnedAt), pinned_at: toIso(after.pinnedAt), chats: after.chats.map((c) => chatData(c, now)) } : {}),
    },
  };
}

// ---- Images -----------------------------------------------------------------------------------

// A picture in a Paseo chat is markdown image syntax in an agent's message: the daemon turns an
// image a tool returned (a screenshot, an image file the agent read) into
// ![Image](file:///…/paseo-attachments-…/<sha256>.png), and agents link files themselves. This is
// the pattern Paseo's own client renders.
// Code spans and fenced blocks come first in the alternation and are kept as they are: an agent
// writing about image syntax in `code` has not shown an image.
const IMAGE_MARKDOWN = /(```[\s\S]*?```|`[^`\n]*`)|!\[([^\]]*)]\((<[^>]+>|[^)\n]+)\)/g;

// Image types a model can look at, by file extension. Paseo serves SVG as an image too, but models
// do not take it; BMP, TIFF and HEIC Paseo serves as plain bytes.
const IMAGE_TYPES = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" };

// The source inside the parentheses, without a "title" or <angle brackets>, in that order:
// ![shot](<my shot.png> "after the fix").
function imageSource(raw) {
  const value = (/^(.*?)(?:\s+(['"]).*?\2)?$/.exec(String(raw ?? "").trim())?.[1] ?? "").trim();
  return value.startsWith("<") && value.endsWith(">") ? value.slice(1, -1).trim() : value;
}

// Replaces each image in `text` with "[image N]", numbering from `first`, and returns the images
// in reading order, so a local path never reaches speech or the model.
export function withImagePlaceholders(text, first = 1) {
  const images = [];
  const replaced = String(text ?? "").replace(IMAGE_MARKDOWN, (match, code, alt, raw) => {
    if (code) return match;
    const n = first + images.length;
    images.push({ n, alt: alt.trim(), source: imageSource(raw) });
    return `[image ${n}]`;
  });
  return { text: replaced, images };
}

// Text with every image as "[image]", for places that do not number them.
export function withoutImages(text) {
  return String(text ?? "").replace(IMAGE_MARKDOWN, (match, code) => code ?? "[image]");
}

export function imageMime(path) {
  const extension = String(path ?? "").split(/[?#]/)[0].split(".").at(-1)?.toLowerCase();
  return IMAGE_TYPES[extension] ?? null;
}

// Where an image's bytes are. A file becomes { file: { cwd, path } } for the daemon's file read: its
// directory as the root and its name inside it, or the agent's working directory for a relative
// path. Inline data is used as it is. Web links stay links: the Site never fetches them.
export function imageTarget(source, cwd) {
  const value = String(source ?? "").trim();
  if (/^data:/i.test(value)) {
    const match = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i.exec(value);
    const mime = match?.[1].toLowerCase().replace("image/jpg", "image/jpeg");
    return mime && Object.values(IMAGE_TYPES).includes(mime) ? { inline: { mime, data: match[2].replace(/\s/g, "") } } : { unsupported: true };
  }
  if (/^https?:\/\//i.test(value)) return { link: value };
  let path = value;
  if (/^file:\/\//i.test(value)) {
    try {
      path = decodeURIComponent(new URL(value).pathname);
    } catch {
      return { unsupported: true };
    }
  }
  if (!imageMime(path)) return { unsupported: true };
  if (path.startsWith("/") || path.startsWith("~/")) {
    const cut = path.lastIndexOf("/");
    return { file: { cwd: path.slice(0, cut) || "/", path: path.slice(cut + 1) } };
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(path) || !cwd) return { unsupported: true };
  return { file: { cwd, path: path.replace(/^\.\//, "") } };
}

// How an image is named aloud: the agent's alt text when it gave one, else "image N".
export function imageName(image) {
  const alt = String(image.alt ?? "").trim();
  return alt && !/^image$/i.test(alt) ? truncate(alt, 60) : `image ${image.n}`;
}

// What read_chat says about a turn's images, and the structured form of each.
export function imageHint(turn, count) {
  return `${count} image(s) in turn ${turn}: show_images (turn ${turn}) puts them on the user's screen.`;
}

// The most of a reply a write's answer carries.
export const REPLY_SHOWN = 1500;

// A reply cut to fit, with its whole length and, when it was cut, the line that says so and how to
// read the rest: it is the agent's last message, which read_message reads whole as turn 1.
export function replyPart(text) {
  const reply = truncate(text, REPLY_SHOWN);
  const truncated = String(text ?? "").trim().length > REPLY_SHOWN;
  return {
    reply,
    data: { reply, reply_chars: charCount(text), reply_truncated: truncated },
    note: truncated ? `The reply is cut to ${REPLY_SHOWN} of its ${charCount(text)} characters: read_message (turn 1) reads it whole.` : null,
  };
}

// The agent's final message after a write, with its images as placeholders and counted.
export function repliedOutcome(message) {
  const { text, images } = withImagePlaceholders(message ?? "(no text)");
  const part = replyPart(text);
  const lines = [`Agent replied: ${part.reply}`, part.note];
  if (images.length === 0) return { text: lines.filter(Boolean).join("\n"), data: { outcome: "replied", delivered: true, ...part.data } };
  return {
    text: [...lines, `The reply has ${images.length} image(s); show_images puts them on the user's screen.`].filter(Boolean).join("\n"),
    data: { outcome: "replied", delivered: true, ...part.data, images: images.length },
  };
}

export function imageRef(image, cwd) {
  const target = imageTarget(image.source, cwd);
  return { n: image.n, name: imageName(image), viewable: Boolean(target.file || target.inline) };
}

const SKIP_REASONS = {
  missing: "no longer on the Mac (a temporary file that was cleaned up); the agent can take it again",
  too_large: "larger than 1 MB",
  too_much_at_once: "more than fits in one answer; ask for it on its own",
  link: "a web link, not a file on the Mac",
  unsupported: "not a PNG, JPEG, WebP or GIF image",
  refused: "outside what Paseo lets it read",
  error: "could not be read",
};

// show_images in words to be spoken: which chat, which turn, what is on the screen and what could
// not be shown. Never paths or ids.
export function imagesText({ chat, turn, found, shown, skipped }) {
  const where = `${truncate(chat.title, 70)} (${chat.project})`;
  if (found === 0) return `No images in ${turn ? `turn ${turn} of ` : "the latest turns of "}${where}.`;
  const lines = [];
  if (shown.length > 0) {
    const turns = [...new Set(shown.map((i) => i.turn))];
    lines.push(
      `Showing ${shown.length} image(s) from ${where}, ${turns.length === 1 ? `turn ${turns[0]}` : `turns ${turns.join(", ")}`}: ${shown.map((i) => i.name).join(", ")}. They are on the user's screen now.`,
      "Answer about them only from what you can see; if they are not visible to you, say they are on the screen and do not guess what they show.",
    );
  }
  for (const s of skipped) lines.push(`Not shown: ${s.name}, ${SKIP_REASONS[s.reason] ?? SKIP_REASONS.error}.`);
  if (found > shown.length + skipped.length) lines.push(`${found - shown.length - skipped.length} more image(s) in these turns; ask for them with turn or count.`);
  return lines.join("\n");
}

// One shell command, edit, read or search from a tool call, with its output cut
// to `max` characters.
export function describeToolCall(item, max) {
  const detail = item.detail ?? {};
  const failed = item.status === "failed" ? " (failed)" : "";
  switch (detail.type) {
    case "shell":
      return [`$ ${truncate(detail.command, 160)}${failed}`, detail.output ? truncate(detail.output, max) : null]
        .filter(Boolean)
        .join("\n");
    case "edit":
    case "write":
      return `${detail.type} ${detail.filePath}${failed}`;
    case "read":
      return `read ${detail.filePath}${failed}`;
    case "search":
      return `search "${detail.query}"${failed}`;
    case "fetch":
      return `fetch ${detail.url}${failed}`;
    case "sub_agent":
      return `${item.name} ${detail.subAgentType ?? ""}: ${truncate(detail.description ?? "", 160)}${failed}`;
    default:
      return `${item.name}${failed}`;
  }
}

// ---- read_activity ----------------------------------------------------------------------------

export function duration(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

const firstSentence = (text) => String(text ?? "").trim().split(/(?<=[.!?])\s|\n/)[0];
const fileName = (path) => String(path ?? "").split("/").filter(Boolean).at(-1) ?? "";

// Timeline items that show what an agent is doing. Claude Code's task notifications (a background
// command has finished) are bookkeeping, not a step.
export const isStep = (item) => (["tool_call", "reasoning", "assistant_message"].includes(item?.type) && item.name !== "task_notification") || item?.type === "compaction";

// What one timeline item says about work in progress, short enough to speak: the command, the
// file name, the site — never a whole path or link.
export function describeStep(item, max = 100) {
  if (!item) return null;
  if (item.type === "tool_call") {
    const detail = item.detail ?? {};
    switch (detail.type) {
      case "shell":
        return truncate(`running ${detail.command}`, max);
      case "read":
        return `reading ${fileName(detail.filePath)}`;
      case "edit":
      case "write":
        return `editing ${fileName(detail.filePath)}`;
      case "search":
        return truncate(`searching for "${detail.query}"`, max);
      case "fetch": {
        let host = String(detail.url ?? "");
        try {
          host = new URL(host).hostname;
        } catch {}
        return `opening ${host}`;
      }
      case "sub_agent":
        return truncate(`waiting for a subagent: ${detail.description ?? detail.subAgentType ?? "a task"}`, max);
      default:
        return `using ${item.name}`;
    }
  }
  if (item.type === "reasoning") return truncate(`thinking: ${firstSentence(item.text)}`, max);
  if (item.type === "assistant_message") return truncate(`writing: ${firstSentence(withoutImages(item.text))}`, max);
  if (item.type === "compaction") return item.status === "completed" ? "compacted the context" : "compacting the context";
  return null;
}

// "general-purpose · Opus 5.5 · Max · 45.1k tokens" → "45.1k"
export function tokensOf(subtitle) {
  return String(subtitle ?? "").match(/([\d.]+k?) tokens/)?.[1] ?? null;
}

// The effort levels Paseo writes into a subtitle for Claude (its formatEffort: "xhigh" reads
// "Extra High"). A subtitle part standing alone is an effort only if it is one of these.
const EFFORT_LABELS = new Set(["low", "medium", "high", "extra high", "max"]);

// The model and the thinking effort a Claude subagent runs on, out of the subtitle Paseo keeps for it:
// "general-purpose · Opus 5.5 · Max · 45.1k tokens" → { model: "Opus 5.5", effort: "Max" }.
// Paseo builds that subtitle from what it observed, not from what was asked: the model from the
// subagent's own replies, the effort from the level Claude Code reports as in force (after any
// downgrade the model needed). Its parts are the title, the model, the effort and the tokens, each
// there only once known, so a missing one stays null: a lone "Max" is an effort with no model yet
// (a subagent resumed by SendMessage is that), never a model, and a layout that fits neither case
// reads as unknown rather than as a guess.
export function subagentRuntime(subtitle, title) {
  let rest = String(subtitle ?? "").trim();
  const name = String(title ?? "").trim();
  if (name && (rest === name || rest.startsWith(`${name} · `))) rest = rest.slice(name.length).replace(/^ · /, "");
  rest = rest.replace(/(^| · )[\d.]+k? tokens$/, "");
  const parts = rest.split(" · ").filter(Boolean);
  if (parts.length === 2) return { model: parts[0], effort: parts[1] };
  if (parts.length === 1) return EFFORT_LABELS.has(parts[0].toLowerCase()) ? { model: null, effort: parts[0] } : { model: parts[0], effort: null };
  return { model: null, effort: null };
}

// Only Claude's subtitle layout is known to this code; another runtime's subagents stay unknown.
const runtimeOf = (s) => (s.provider === "claude" ? subagentRuntime(s.subtitle, s.title) : { model: null, effort: null });

// "Opus 5.5, Max effort" for a subagent's line; what Paseo has not reported is said so, not left out.
function runtimeLabel({ model, effort }) {
  if (model && effort) return `${model}, ${effort} effort`;
  if (model) return `${model}, effort not reported`;
  if (effort) return `model not reported, ${effort} effort`;
  return "model and effort not reported";
}

// What a chat and its subagents are doing now. `subagents` are Paseo's provider-subagent
// descriptors, the shown ones carrying `step` (latest tool call or thought) and `result` (final
// message) read from their timelines. Running ones come first, then those finished in the latest
// turn; older ones only count.
export function activityData({ chat, subagents, turnStartedAt, parentStep, now = Date.now(), limit = 6 }) {
  const running = subagents.filter((s) => s.status === "running");
  const start = Date.parse(turnStartedAt ?? "") || 0;
  const finished = subagents
    .filter((s) => s.status !== "running" && Date.parse(s.createdAt) >= start)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  const parentRunning = ["running", "initializing"].includes(chat.status);
  const waitingOnHelpers = running.length > 0 && (!parentStep || parentStep.startsWith("waiting for a subagent"));
  return {
    chat: chatData({ ...chat, subagentsRunning: running.length }, now),
    working: parentRunning || running.length > 0,
    turn_started_at: toIso(turnStartedAt),
    turn_elapsed: parentRunning && start ? duration(now - start) : null,
    current_step: parentRunning ? (waitingOnHelpers ? `waiting for ${running.length} subagent(s)` : (parentStep ?? null)) : null,
    subagents_running: running.length,
    subagents_done: subagents.length - running.length,
    subagents: [...running, ...finished].slice(0, limit).map((s) => ({
      id: s.id,
      title: s.title || "subagent",
      task: s.description ?? "",
      status: s.status,
      started_at: toIso(s.createdAt),
      updated_at: toIso(s.updatedAt),
      elapsed: duration((s.status === "running" ? now : Date.parse(s.updatedAt)) - Date.parse(s.createdAt)),
      current_step: s.status === "running" ? (s.step ?? null) : null,
      ...resultOf(s),
      tokens: tokensOf(s.subtitle),
      ...runtimeOf(s),
    })),
  };
}

// The most of a subagent's final message read_activity carries, and of that the most its text says.
const RESULT_SHOWN = 300;
const RESULT_SPOKEN = 160;

// A finished subagent's final message, cut to fit, with its whole length and the id read_message
// reads all of it by. The id is there even when the message was not read: read_message finds it.
function resultOf(s) {
  if (s.status === "running") return { result: null };
  const whole = s.result ?? null;
  return {
    result: whole === null ? null : truncate(whole, RESULT_SHOWN),
    ...(whole === null ? {} : { result_chars: charCount(whole), result_truncated: whole.trim().length > RESULT_SHOWN }),
    result_id: subagentRef(s.id),
  };
}

export function activityText(activity) {
  const { chat } = activity;
  const head = activity.working
    ? `${chat.title} (${chat.project}) is working${activity.turn_elapsed ? `, ${activity.turn_elapsed} into the turn` : ""}${activity.current_step ? `: ${activity.current_step}` : ""}.`
    : `${chat.title} (${chat.project}) is not working now: ${chat.state}, ${chat.updated_ago}.`;
  const context = contextLine(chat.context);
  // Before the list, so it stays when the answer is cut to max_chars.
  const cut = activity.subagents.some((s) => s.result && (s.result_truncated || s.result.trim().length > RESULT_SPOKEN))
    ? "Results are cut here: read_message with a subagent's result_id reads its whole final message."
    : null;
  const lines = activity.subagents.map((s) =>
    s.status === "running"
      ? `- ${s.title} (${runtimeLabel(s)}) "${truncate(s.task, 80)}": running for ${s.elapsed}${s.current_step ? `, now ${s.current_step}` : ""}.`
      : `- ${s.title} (${runtimeLabel(s)}) "${truncate(s.task, 80)}": ${s.status} after ${s.elapsed}${s.result ? `. Result: ${truncate(s.result, RESULT_SPOKEN)}` : "."}`,
  );
  return [head, context, cut, ...lines].filter(Boolean).join("\n");
}

// ---- read_message -----------------------------------------------------------------------------

// The most characters one answer carries of a message, and what a head or a tail takes when no size
// is asked for. A longer message is read in pages, never cut without saying so. A page is as long as
// read_chat's longest answer (max_chars 6000), the size known to reach the model whole: ChatGPT cuts a
// tool's answer that goes over a budget it does not publish.
export const MESSAGE_PAGE = 6_000;
export const MESSAGE_PIECE = 1_500;
export const MESSAGE_MODES = ["head", "tail", "full"];
export const MESSAGE_ROLES = ["user", "agent"];
// What read_message reads by an id besides messages: a turn's thinking, a tool call, a subagent's
// last message.
export const MESSAGE_KINDS = [...MESSAGE_ROLES, "thinking", "call", "subagent"];

// Characters are Unicode code points, so the two halves of an emoji are never split between pages
// and the counts are what a person would count.
export const charCount = (text) => Array.from(String(text ?? "")).length;

// A message goes by its role and the timeline position where it starts. That position holds still
// when the chat moves on; "the latest turn" does not. A turn's thinking goes by its turn's start, a
// tool call by where it starts, a subagent by Paseo's id for it.
export const messageRef = (role, seq) => `${role}-${seq}`;
export const subagentRef = (id) => `subagent-${id}`;

export function parseMessageRef(value) {
  const text = String(value ?? "").trim();
  const placed = /^(user|agent|thinking|call)-(\d+)$/.exec(text);
  if (placed) return { role: placed[1], seq: Number(placed[2]) };
  const subagent = /^subagent-([\w-]+)$/.exec(text);
  return subagent ? { role: "subagent", id: subagent[1] } : null;
}

// A text made of parts the way read_chat joins them (a turn's thoughts): trimmed, the empty ones left
// out, a blank line between.
export const joined = (parts) => parts.map((p) => String(p ?? "").trim()).filter(Boolean).join("\n\n");

// One tool call whole, as read_message gives it: what was run or asked and what came back. A file an
// agent read, edited or wrote stays a path, as read_chat shows it.
export function callText(item) {
  const detail = item.detail ?? {};
  const failed = item.status === "failed" ? " (failed)" : "";
  const value = (v) => (typeof v === "string" ? v : v === undefined || v === null ? "" : JSON.stringify(v, null, 2));
  const error = item.status === "failed" ? value(item.error?.content ?? item.error?.message ?? item.error) : "";
  const parts = (() => {
    switch (detail.type) {
      case "shell":
        return [`$ ${detail.command ?? ""}${failed}`, value(detail.output)];
      case "plan":
        return [`${item.name}${failed}: the plan`, value(detail.text)];
      case "sub_agent":
        return [`${item.name} ${detail.subAgentType ?? ""}: ${String(detail.description ?? "").trim()}${failed}`, value(detail.log)];
      case "plain_text":
        return [`${item.name}${failed}`, value(detail.text)];
      case "edit":
      case "write":
      case "read":
      case "search":
      case "fetch":
        return [describeToolCall(item, Infinity)];
      default:
        return [`${item.name}${failed}`, detail.input === undefined ? "" : `input: ${value(detail.input)}`, detail.output === undefined ? "" : `output: ${value(detail.output)}`];
    }
  })();
  return [...parts, error && `error: ${error}`].filter(Boolean).join("\n");
}

// One window of a message: head takes the first `size` characters, tail the last `size`, full `size`
// from `offset`. An offset past the end gives an empty window at the end.
export function messageWindow(text, { mode = "full", size = MESSAGE_PAGE, offset = 0 } = {}) {
  const chars = Array.from(String(text ?? ""));
  const total = chars.length;
  const width = Math.max(1, Math.trunc(size) || 1);
  let start = Math.min(Math.max(0, Math.trunc(offset) || 0), total);
  if (mode === "head") start = 0;
  if (mode === "tail") start = Math.max(0, total - width);
  const end = Math.min(total, start + width);
  return { text: chars.slice(start, end).join(""), total, start, end };
}

// The part just before a window: a page of `size` ending where the window starts, or all of the
// message's start when that is shorter.
const partBefore = (window, size) => ({ offset: Math.max(0, window.start - size), size: Math.min(size, window.start) });

// A piece of a message as fields. `found` is the message the operation located, `window` the piece.
export function messageData({ chat, found, mode, size, window, cwd }) {
  const images = found.images ?? [];
  return {
    chat,
    total_turns: found.total,
    turn: found.turn,
    position: found.position,
    role: found.role,
    message_id: found.id,
    // An agent writes several messages in a turn, counted from the last; a user's turn holds one.
    ...(found.role === "agent" ? { message: found.number, ...(found.count === undefined ? {} : { agent_messages: found.count }) } : {}),
    started_at: toIso(found.at),
    mode,
    total_chars: window.total,
    offset: window.start,
    returned_chars: window.end - window.start,
    remaining_chars: window.total - window.end,
    truncated: window.start > 0 || window.end < window.total,
    next_offset: window.end < window.total ? window.end : null,
    previous_offset: window.start > 0 ? partBefore(window, size).offset : null,
    text: window.text,
    ...(images.length ? { images: images.map((i) => imageRef(i, cwd)) } : {}),
  };
}

// The same as text to read: which message, which part of it, what is left on either side and how to
// get it, then the part itself. The way on comes before the part, so it is read even when a client
// cuts a long answer short. `asked` is the offset the caller gave, for when it was past the end.
export function messageText({ chatLine, found, mode, window, size, asked = 0 }) {
  const who = {
    user: "The user's message",
    thinking: "The agent's thinking",
    call: `The tool call ${found.name}`,
    subagent: `The last message of subagent "${found.title}"`,
  }[found.role] ?? (found.number === 1 ? "The agent's last message" : `The agent's message ${found.number}${found.count ? ` of ${found.count}` : ""} counted from the last`);
  const shown = window.end - window.start;
  const edge = mode === "head" ? ", the start" : mode === "tail" ? ", the end" : "";
  let range = `${shown} of ${window.total} characters, offset ${window.start} to ${window.end}${edge}.`;
  if (window.start === 0 && window.end === window.total) range = window.total === 0 ? "empty." : `all ${window.total} characters.`;
  else if (shown === 0) range = `there is nothing at offset ${asked}: the message has ${window.total} characters.`;
  const around = [];
  if (window.end < window.total) {
    around.push(`${window.total - window.end} more characters follow: call read_message again with message_id ${found.id}, mode full and offset ${window.end}.`);
  }
  if (window.start > 0) {
    const before = partBefore(window, size);
    around.push(`${window.start} characters come before: message_id ${found.id}, mode full, offset ${before.offset} and size ${before.size} read the part just before this one.`);
  }
  const images = (found.images ?? []).length ? ["", imageHint(found.turn, found.images.length)] : [];
  // A subagent's message belongs to the subagent, not to a turn of the chat.
  const where = found.turn === undefined ? "" : `, turn ${found.turn} of ${found.total} counted from the latest`;
  return [chatLine, `${who}${where}: ${range}`, ...around, ...(shown > 0 ? ["", window.text] : []), ...images].join("\n");
}
