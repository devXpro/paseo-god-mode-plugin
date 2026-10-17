// A fake Paseo for the eval: projects, chats, turns and subagents shaped like the real daemon's
// data after core/paseo.mjs maps it. Times are relative to process start. Every stub process gets
// a fresh copy, and write operations change it, so state stays consistent within one run.

const MIN = 60_000;

export const NEW_CHAT_ID = "9f8e7d6c-5b4a-4c3d-8e2f-1a0b9c8d7e6f";

export function createWorld(now = Date.now()) {
  const ago = (minutes) => new Date(now - minutes * MIN).toISOString();
  const shell = (command, status = "completed", output = "") => ({ type: "tool_call", name: "Bash", status, detail: { type: "shell", command, output } });
  const read = (filePath) => ({ type: "tool_call", name: "Read", status: "completed", detail: { type: "read", filePath } });
  const task = (description, status, subAgentType = "general-purpose") => ({
    type: "tool_call",
    name: "Task",
    status,
    detail: { type: "sub_agent", subAgentType, description, log: "" },
  });

  const projects = [
    { name: "proxy", directory: "/Users/roman/projects/proxy" },
    { name: "jobby-jobs", directory: "/Users/roman/projects/jobby-jobs" },
    { name: "sends", directory: "/Users/roman/projects/sends" },
    { name: "paseo-chatgpt-voice", directory: "/Users/roman/projects/sandbox/paseo-chatgpt-voice" },
    { name: "paseo-god-mode-plugin", directory: "/Users/roman/projects/paseo-god-mode-plugin" },
  ];

  const chat = (fields) => ({ workspace: null, attention: null, permissions: [], archived: false, subagents: [], ...fields });

  const chats = [
    chat({
      id: "a22524fe-055b-44b8-a9b6-82c9910d7e21",
      title: "Карта флота (SRV-274), этап D — UX фронта",
      project: "proxy",
      workspace: "Карта флота D",
      status: "idle",
      attention: "permission",
      permissions: [
        {
          id: "perm-e2e",
          kind: "tool",
          name: "Bash",
          title: "Bash",
          detail: { type: "shell", command: "npm run test:e2e" },
          actions: [
            { id: "allow-once", behavior: "allow" },
            { id: "reject", behavior: "deny" },
          ],
        },
      ],
      updatedAt: ago(8),
      createdAt: ago(240),
      turns: [
        {
          at: ago(240),
          end: ago(200),
          user: "Доводим UX фронта карты флота, этап D: кластеры маркеров и фильтр по статусу судна.",
          agent: [
            "Сделал кластеризацию маркеров и фильтр по статусу судна. Осталось прогнать e2e.",
            // The way the daemon records a screenshot a tool returned.
            "![Image](file:///var/folders/f7/xtj/T/paseo-attachments-Eval01/3f2a9c4e8b7d6a5f1e0c9b8a7d6e5f4c3b2a1908f7e6d5c4b3a29180f7e6d5c4.png)",
          ],
          calls: [read("web/src/map/FleetMap.tsx"), shell("npm run lint")],
        },
        {
          at: ago(10),
          end: ago(8),
          user: "Прогони e2e и почини, если что-то упадёт.",
          agent: ["Запускаю e2e-тесты карты, нужно разрешение на команду."],
          calls: [shell("npm run test:e2e", "running")],
        },
      ],
    }),
    chat({
      id: "b7c1d2e3-4f50-4a61-8b72-93a4b5c6d7e8",
      title: "Рефакторинг auth middleware",
      project: "jobby-jobs",
      workspace: "auth refactor",
      status: "running",
      updatedAt: ago(1),
      createdAt: ago(35),
      turns: [
        {
          at: ago(35),
          end: null,
          user: "Отрефактори auth middleware: вынеси проверку сессии в отдельный модуль и покрой интеграционными тестами.",
          agent: ["Сначала соберу все места, где вызывается авторизация, и параллельно начну интеграционные тесты."],
          calls: [
            task("Map API routes", "completed", "Explore"),
            task("Find every auth call site", "running", "Explore"),
            task("Write integration tests for the session module", "running"),
          ],
        },
      ],
      subagents: [
        {
          id: "toolu_01MapApiRoutes",
          title: "Explore",
          task: "Map API routes",
          status: "completed",
          createdAt: ago(33),
          updatedAt: ago(30),
          tokens: "38.2k",
          current: null,
          result: "Нашёл 14 маршрутов; три обходят auth middleware: /health, /webhook и /metrics.",
        },
        {
          id: "toolu_01FindAuthCalls",
          title: "Explore",
          task: "Find every auth call site",
          status: "running",
          createdAt: ago(29),
          updatedAt: ago(0.3),
          tokens: "52.4k",
          current: "reading src/auth/session.ts",
          result: null,
        },
        {
          id: "toolu_01WriteSessionTests",
          title: "general-purpose",
          task: "Write integration tests for the session module",
          status: "running",
          createdAt: ago(27),
          updatedAt: ago(0.5),
          tokens: "61.0k",
          current: "running: npm test -- auth/session",
          result: null,
        },
      ],
    }),
    chat({
      id: "c3d4e5f6-1a2b-4c3d-9e4f-5a6b7c8d9e0f",
      title: "Release notes 0.6",
      project: "sends",
      workspace: "release notes",
      status: "idle",
      attention: "finished",
      updatedAt: ago(25),
      createdAt: ago(90),
      turns: [
        {
          at: ago(90),
          end: ago(70),
          user: "Собери release notes для sends 0.6 из коммитов с прошлого тега.",
          agent: ["Собрал черновик из 23 коммитов и сгруппировал по разделам: новое, исправления, инфраструктура."],
          calls: [shell("git log v0.5.0..HEAD --oneline")],
        },
        {
          at: ago(30),
          end: ago(25),
          user: "Сделай короче и человеческим языком.",
          agent: ["Готово: сократил до семи пунктов, черновик лежит в docs/release-0.6.md. Перевести его на английский?"],
          calls: [{ type: "tool_call", name: "Write", status: "completed", detail: { type: "write", filePath: "docs/release-0.6.md" } }],
        },
      ],
    }),
    chat({
      id: "d4e5f6a7-2b3c-4d5e-8f60-718293a4b5c6",
      title: "План раскатки DNSSEC",
      project: "proxy",
      status: "idle",
      updatedAt: ago(2 * 24 * 60),
      createdAt: ago(3 * 24 * 60),
      turns: [
        {
          at: ago(3 * 24 * 60),
          end: ago(3 * 24 * 60 - 20),
          user: "Распиши план раскатки DNSSEC для всех зон.",
          agent: ["План: 1) подписать staging-зону, 2) проверить валидацию резолверами, 3) опубликовать DS у регистратора, 4) настроить ротацию KSK раз в год."],
          calls: [],
        },
        {
          at: ago(2 * 24 * 60 + 60),
          end: ago(2 * 24 * 60 + 50),
          user: "А что с ротацией ZSK?",
          agent: ["ZSK ротируем раз в 90 дней автоматически, KSK вручную раз в год с двойной подписью."],
          calls: [],
        },
        {
          at: ago(2 * 24 * 60 + 5),
          end: ago(2 * 24 * 60),
          user: "Ок, оформи это в документ.",
          agent: ["Записал план раскатки DNSSEC в docs/dnssec-rollout.md."],
          calls: [{ type: "tool_call", name: "Write", status: "completed", detail: { type: "write", filePath: "docs/dnssec-rollout.md" } }],
        },
      ],
    }),
    chat({
      id: "e5f6a7b8-3c4d-4e5f-9a01-2b3c4d5e6f70",
      title: "Обновить README",
      project: "jobby-jobs",
      status: "idle",
      updatedAt: ago(180),
      createdAt: ago(200),
      turns: [
        {
          at: ago(200),
          end: ago(180),
          user: "Обнови README: установка, переменные окружения, запуск тестов.",
          agent: ["README обновлён: добавил разделы про установку, переменные окружения и запуск тестов."],
          calls: [{ type: "tool_call", name: "Edit", status: "completed", detail: { type: "edit", filePath: "README.md" } }],
        },
      ],
    }),
    chat({
      id: "f6a7b8c9-4d5e-4f60-8a12-3b4c5d6e7f81",
      title: "Voice smoke test",
      project: "paseo-chatgpt-voice",
      status: "idle",
      updatedAt: ago(26 * 60),
      createdAt: ago(27 * 60),
      turns: [{ at: ago(27 * 60), end: ago(27 * 60 - 1), user: "Smoke test only. Reply exactly: pong", agent: ["pong"], calls: [] }],
    }),
    chat({
      id: "0a1b2c3d-5e6f-4a70-9b81-c2d3e4f5a6b7",
      title: "Фикс вебхука Telegram-бота",
      project: "sends",
      workspace: "webhook fix",
      status: "idle",
      attention: "finished",
      updatedAt: ago(15),
      createdAt: ago(120),
      turns: [
        {
          at: ago(120),
          end: ago(15),
          user: "Почини вебхук Telegram-бота: сообщения теряются при рестарте.",
          agent: ["Нашёл причину: вебхук отвечал 500, пока не прогрет кэш. Добавил очередь и ретраи. Запустил в фоне нагрузочный тест, отпишусь по результату."],
          calls: [shell("npm test -- webhook"), task("Load-test the webhook at 500 rps", "running", "Workflow")],
        },
      ],
      subagents: [
        {
          id: "toolu_01LoadTestWebhook",
          title: "Workflow",
          task: "Load-test the webhook at 500 rps",
          status: "running",
          createdAt: ago(14),
          updatedAt: ago(2),
          tokens: "12.7k",
          // Backgrounded subagents report no steps, only their token count.
          current: null,
          result: null,
        },
      ],
    }),
  ];

  return { now, projects, chats, ago };
}
