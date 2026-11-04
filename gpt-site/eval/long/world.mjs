// A fake Paseo for the long-text eval: two chats whose long texts hide facts in their tails, where
// only a model that reads on finds them. Paged the way the daemon pages (tail, before and after a
// cursor, search pages of 200 oldest first, subagent timelines).
const NOW = Date.parse("2026-11-04T10:00:00Z");
const at = (minutes) => new Date(NOW - minutes * 60_000).toISOString();
const user = (text) => ({ type: "user_message", text });
const agent = (text) => ({ type: "assistant_message", text });
const thought = (text) => ({ type: "reasoning", text });
const bash = (command, output) => ({ type: "tool_call", callId: `c-${command.slice(0, 8)}-${output.length}`, name: "Bash", status: "completed", error: null, detail: { type: "shell", command, output } });
const ssh = (output) => ({ type: "tool_call", callId: "c-ssh", name: "mcp__proxy-mcp-prod__ssh_exec", status: "completed", error: null, detail: { type: "unknown", input: { host: "reminders-1", command: "journalctl -u reminders -n 400" }, output } });
const subagentCall = (id, description) => ({ type: "tool_call", callId: id, name: "Agent", status: "completed", error: null, detail: { type: "sub_agent", subAgentType: "general-purpose", description, log: "", actions: [] } });

// Russian filler that reads like an agent's prose, `n` sentences on a topic.
const SENTENCES = [
  "Здесь важно не путать хранение и доставку напоминаний",
  "Мы смотрим, что можно прочитать без записи и без лишних прав",
  "Каждый источник даёт свой набор полей и свои ограничения",
  "При синхронизации нужно учитывать часовой пояс пользователя",
  "Дубликаты появляются, когда одно напоминание живёт в двух местах",
  "Отдельно проверяем, что будет при потере сети на телефоне",
];
const prose = (topic, n) => Array.from({ length: n }, (_, i) => `${SENTENCES[i % SENTENCES.length]} (${topic}, ${i + 1}).`).join(" ");

function sevenSections() {
  const body = (n) => prose(`развилка ${n}`, 22);
  const sections = [
    ["Где хранить список напоминаний", ""],
    ["Как читать ChatGPT Tasks", ""],
    ["Нужен ли свой бот", ""],
    ["Синхронизация с календарём", ""],
    ["Что делать с повторами", ""],
    ["Напоминания Telegram в «Избранном»", " Ключевой факт: Telegram держит отложенные сообщения в «Избранном» до 365 дней, а бот прочитать их не может."],
    ["Когда звонить — по расписанию или когда ChatGPT задачу выполнил", " Ключевой факт: звонок по расписанию в 07:45, а по выполнению — сразу после отметки done в ChatGPT."],
  ];
  return [
    "Кадр, держи развилки по архитектуре напоминаний только для чтения. Коротко по каждой:",
    ...sections.map(([title, fact], i) => `## ${i + 1}. ${title}\n\n${body(i + 1)}${fact}`),
  ].join("\n\n");
}

function longThinking() {
  const parts = Array.from({ length: 10 }, (_, i) => `Шаг ${i + 1}. ${prose(`мысль ${i + 1}`, 18)}`);
  parts[9] += " Итог рассуждения: хранить напоминания в SQLite с журналом WAL и делать бэкап раз в сутки.";
  return parts;
}

function testRun() {
  const lines = Array.from({ length: 140 }, (_, i) => `PASS src/module-${i}.spec.ts (${(i % 9) + 1}.${i % 10} s)`);
  return [...lines, "", "FAIL src/reminders.spec.ts › schedules the 07:45 call", "FAIL src/sync.spec.ts › dedupes Saved Messages", "", "Tests: 2 failed, 140 passed, 142 total"].join("\n");
}

function journal() {
  const lines = Array.from({ length: 260 }, (_, i) => `Nov 04 09:${String(i % 60).padStart(2, "0")}:00 reminders-1 reminders[812]: tick ${i} ok, queue ${i % 7}`);
  return [...lines, "Nov 04 09:59:59 reminders-1 reminders[812]: ERROR disk full on /var/lib/reminders, writes stopped"].join("\n");
}

function subagentReport(letter, fact, n) {
  return `Отчёт ${letter}. ${prose(`отчёт ${letter}`, n)} ИТОГ-${letter}: ${fact}`;
}

export function createDaemon() {
  const chats = [];
  const add = ({ id, title, project, items, subagents = [], minutesAgo = 1 }) => {
    const entries = items.map((item, i) => ({
      item,
      timestamp: at(minutesAgo + items.length - i),
      seqStart: 10 + i * 7,
      seqEnd: 10 + i * 7 + (["assistant_message", "tool_call"].includes(item.type) ? 3 : 0),
    }));
    chats.push({
      agent: { id, title, status: "idle", requiresAttention: false, pendingPermissions: [], updatedAt: at(minutesAgo), createdAt: at(600), cwd: `/Users/r/${project}`, lastUsage: null, provider: "claude", model: "claude-opus-5-5" },
      project: { projectName: project, workspaceName: title },
      entries,
      subagents,
    });
  };

  // Chat A: eight turns. Position 3: long thinking; 4: a test run; 6: the seven-section answer;
  // 8 (latest): three subagents.
  const subIds = ["toolu_01AaaReminders0000000000", "toolu_01BbbTasks000000000000000", "toolu_01CccApple000000000000000"];
  add({
    id: "fc21d227-5052-4360-ade7-9972eb618f80",
    title: "Research ChatGPT reminders read-only architecture",
    project: "voxbridge",
    minutesAgo: 2,
    items: [
      user("Исследуй идею напоминаний из ChatGPT только для чтения"), agent("Понял, начну с источников."),
      user("Какие есть источники?"), agent("ChatGPT Tasks, Telegram «Избранное», Apple Reminders."),
      user("Подумай, где лучше хранить напоминания"), ...longThinking().map(thought), agent("Подумал, предлагаю локальную базу."),
      user("Прогони тесты"), bash("ls", "src\ntests"), bash("git status", "clean"), bash("npm ci", "added 812 packages"), ssh(journal()), bash("npm run lint", "0 problems"), bash("npm test", testRun()), agent("Тесты прогнал, есть падения."),
      user("Хорошо"), agent("Ок."),
      user("Распиши развилки"), thought("Нужно перечислить развилки"), agent(sevenSections()),
      user("Понял, спасибо"), agent("Пожалуйста."),
      user("Запусти трёх сабагентов на разбор API"),
      subagentCall(subIds[0], "Telegram API"), subagentCall(subIds[1], "ChatGPT Tasks"), subagentCall(subIds[2], "Apple Reminders"),
      agent("Сабагенты закончили, их отчёты готовы."),
    ],
    subagents: [
      { id: subIds[0], title: "general-purpose", description: "Telegram API", status: "completed", createdAt: at(2.6), updatedAt: at(2.2), items: [agent(subagentReport("А", "бот Telegram не может прочитать отложенные сообщения пользователя.", 70))] },
      { id: subIds[1], title: "general-purpose", description: "ChatGPT Tasks", status: "completed", createdAt: at(2.6), updatedAt: at(2.3), items: [agent(subagentReport("Б", "ChatGPT Tasks нельзя прочитать через API, только через интерфейс.", 55))] },
      { id: subIds[2], title: "general-purpose", description: "Apple Reminders", status: "completed", createdAt: at(2.6), updatedAt: at(2.4), items: [agent(subagentReport("В", "Apple Reminders читаются через EventKit без права записи.", 28))] },
    ],
  });

  // Chat B: forty turns, "голос" in 26 replies, numbered oldest first.
  const items = [];
  let n = 0;
  for (let turn = 1; turn <= 40; turn += 1) {
    items.push(user(`Вопрос ${turn}`));
    items.push(agent(turn % 3 === 0 && turn > 39 ? "Ок." : turn <= 26 || turn % 10 === 0 ? `Про голос: эпизод голос-${(n += 1)} — ${prose(`голос ${n}`, 2)}` : "Другая тема."));
  }
  add({ id: "9c897354-1111-4222-8333-444455556666", title: "Голосовой режим Paseo", project: "voxbridge", minutesAgo: 30, items });

  const byId = (id) => chats.find((c) => c.agent.id === id);
  const page = (list, hasOlder, hasNewer) => ({ epoch: "e1", entries: list, hasOlder, hasNewer });
  return {
    async fetchAgents() {
      return { entries: chats.map((c) => ({ agent: c.agent, project: c.project })) };
    },
    async fetchAgent(id) {
      const c = byId(id);
      return c ? { agent: c.agent, project: c.project } : null;
    },
    async listProjects() {
      return { projects: [{ projectName: "voxbridge", cwd: "/Users/r/voxbridge" }] };
    },
    async listAgentTimelinePrompts(id) {
      const c = byId(id);
      return { epoch: "e1", prompts: c.entries.filter((e) => e.item.type === "user_message").map((e) => ({ seq: e.seqStart, preview: e.item.text.slice(0, 120), timestamp: e.timestamp })) };
    },
    async fetchAgentTimeline(id, { direction = "tail", cursor, limit = 200 } = {}) {
      const all = byId(id).entries;
      if (direction === "tail") {
        const list = all.slice(-limit);
        return page(list, all.length > list.length, false);
      }
      if (direction === "before") {
        const earlier = all.filter((e) => e.seqEnd < cursor.seq);
        const list = earlier.slice(-limit);
        return page(list, earlier.length > list.length, true);
      }
      const later = all.filter((e) => e.seqEnd > cursor.seq);
      const list = later.slice(0, limit);
      return page(list, all.some((e) => e.seqEnd <= cursor.seq), later.length > list.length);
    },
    async searchAgentTimeline({ agentId, query, cursor = 0 }) {
      const words = query.toLowerCase();
      const found = byId(agentId).entries.filter((e) => e.seqEnd > cursor && ["user_message", "assistant_message"].includes(e.item.type) && e.item.text.toLowerCase().includes(words));
      const locations = found.slice(0, 200).map((e) => ({ seq: e.seqEnd, role: e.item.type === "user_message" ? "user" : "assistant", count: 1 }));
      return { epoch: "e1", locations, nextCursor: found.length > 200 ? locations.at(-1).seq : null };
    },
    async listProviderSubagents(id) {
      return { subagents: byId(id).subagents.map((s) => ({ id: s.id, parentAgentId: id, provider: "claude", title: s.title, description: s.description, status: s.status, createdAt: s.createdAt, updatedAt: s.updatedAt, subtitle: `${s.title} · Sonnet 5.5 · Max`, toolCallId: s.id })) };
    },
    async fetchProviderSubagentTimeline(id, sid, { direction = "tail", cursor, limit = 200 } = {}) {
      const s = byId(id).subagents.find((x) => x.id === sid);
      const rows = (s?.items ?? []).map((item, i) => ({ item, timestamp: s.updatedAt, seq: i + 1, seqStart: i + 1, seqEnd: i + 1 }));
      const before = direction === "before" ? rows.filter((r) => r.seqEnd < cursor.seq) : rows;
      const list = before.slice(-limit);
      return { epoch: "s1", rows: list, hasOlder: before.length > list.length, hasNewer: false };
    },
  };
}
