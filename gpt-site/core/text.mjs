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
        "If one of them is the chat this conversation is about, call again with its id; otherwise ask the user which one:",
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

// Cuts at a line or sentence end when one is in the second half, else at a word
// boundary, so speech does not stop mid-word. `max` counts characters.
export function truncate(value, max) {
  const text = String(value ?? "").trim();
  if (text.length <= max) {
    return text;
  }
  const head = text.slice(0, max);
  const sentence = Math.max(head.lastIndexOf("\n"), head.lastIndexOf(". "));
  const space = head.lastIndexOf(" ");
  const cut = sentence > max / 2 ? sentence + 1 : space > max / 2 ? space : max;
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
  const start = Math.max(0, at - radius);
  const end = Math.min(flat.length, at + length + radius);
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
    return `waiting for approval: ${describePermission(chat.permissions[0], 80)}`;
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

// The structured form of one tool call.
export function toolCallData(item, max) {
  return {
    kind: item.detail?.type ?? "tool",
    name: item.name,
    status: item.status,
    text: describeToolCall(item, max),
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

// The agent's final message after a write, with its images as placeholders and counted.
export function repliedOutcome(message) {
  const { text, images } = withImagePlaceholders(message ?? "(no text)");
  const reply = truncate(text, 1500);
  if (images.length === 0) return { text: `Agent replied: ${reply}`, data: { outcome: "replied", delivered: true, reply } };
  return {
    text: `Agent replied: ${reply}\nThe reply has ${images.length} image(s); show_images puts them on the user's screen.`,
    data: { outcome: "replied", delivered: true, reply, images: images.length },
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
      result: s.status === "running" ? null : (s.result ?? null),
      tokens: tokensOf(s.subtitle),
    })),
  };
}

export function activityText(activity) {
  const { chat } = activity;
  const head = activity.working
    ? `${chat.title} (${chat.project}) is working${activity.turn_elapsed ? `, ${activity.turn_elapsed} into the turn` : ""}${activity.current_step ? `: ${activity.current_step}` : ""}.`
    : `${chat.title} (${chat.project}) is not working now: ${chat.state}, ${chat.updated_ago}.`;
  const context = contextLine(chat.context);
  const lines = activity.subagents.map((s) =>
    s.status === "running"
      ? `- ${s.title} "${truncate(s.task, 80)}": running for ${s.elapsed}${s.current_step ? `, now ${s.current_step}` : ""}.`
      : `- ${s.title} "${truncate(s.task, 80)}": ${s.status} after ${s.elapsed}${s.result ? `. Result: ${truncate(s.result, 160)}` : "."}`,
  );
  return [head, context, ...lines].filter(Boolean).join("\n");
}
