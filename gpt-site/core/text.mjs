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
  };
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
export const isStep = (item) => ["tool_call", "reasoning", "assistant_message"].includes(item?.type) && item.name !== "task_notification";

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
  if (item.type === "assistant_message") return truncate(`writing: ${firstSentence(item.text)}`, max);
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
  const lines = activity.subagents.map((s) =>
    s.status === "running"
      ? `- ${s.title} "${truncate(s.task, 80)}": running for ${s.elapsed}${s.current_step ? `, now ${s.current_step}` : ""}.`
      : `- ${s.title} "${truncate(s.task, 80)}": ${s.status} after ${s.elapsed}${s.result ? `. Result: ${truncate(s.result, 160)}` : "."}`,
  );
  return [head, ...lines].join("\n");
}
