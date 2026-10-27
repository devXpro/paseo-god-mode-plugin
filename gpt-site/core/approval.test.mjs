// Run with: node --test core/
// read_approval, answer_questions and answer_approval against a fake daemon that keeps pending
// requests as Paseo 0.13 does: Claude's AskUserQuestion as a request of kind "question", a Codex
// question request, and a plain tool approval. What is sent must be what Paseo's own form sends.
import assert from "node:assert/strict";
import { test } from "node:test";
import { answerApprovalOn, answerQuestionsOn, readApprovalOn } from "./paseo.mjs";

const NOW = Date.now();
const at = (minutes) => new Date(NOW - minutes * 60_000).toISOString();

// Claude asks two questions, the option it recommends marked in each; Paseo adds allowOther.
const RELEASE = {
  id: "permission-7d1e",
  provider: "claude",
  name: "AskUserQuestion",
  kind: "question",
  title: "One test failed once and passed three times after. Continue the release?",
  description: "Continue (Recommended) / Stop",
  input: {
    questions: [
      {
        header: "Release",
        question: "One test failed once and passed three times after. Continue the release?",
        multiSelect: false,
        allowOther: true,
        options: [{ label: "Continue (Recommended)", description: "Release with a note on the flaky test." }, { label: "Stop" }],
      },
      { header: "Daemon", question: "Install the daemon from the tag?", multiSelect: false, allowOther: true, options: [{ label: "Leave it (Recommended)" }, { label: "Install from the tag" }] },
    ],
  },
};
const CODEX_ASK = {
  id: "permission-item-4",
  provider: "codex",
  name: "request_user_input",
  kind: "question",
  title: "Question",
  input: { questions: [{ id: "scope", header: "Scope", question: "Which parts should the refactor touch?", multiSelect: true, options: [{ label: "API" }, { label: "UI" }, { label: "Tests" }] }] },
};
const SECRET = { ...CODEX_ASK, id: "permission-item-5", input: { questions: [{ id: "key", header: "Key", question: "Paste the API key", isOther: true, isSecret: true, options: [] }] } };
const PUBLISH = { id: "perm-1", kind: "tool", name: "Bash", title: "Bash", detail: { type: "shell", command: "npm publish" }, actions: [{ id: "allow-once", label: "Allow", behavior: "allow" }] };

const chat = (id, title, permissions, fields = {}) => ({ id, title, project: "lab", status: "running", minutes: 5, permissions, ...fields });
const ASKING = chat("1f2e3d4c-0000-4000-8000-000000000001", "Release 0.4 of the bridge", [RELEASE]);
const CODEX_CHAT = chat("2a3b4c5d-0000-4000-8000-000000000002", "Refactor billing", [CODEX_ASK], { provider: "codex" });
const PLAIN = chat("3b4c5d6e-0000-4000-8000-000000000003", "Publish the package", [PUBLISH]);
const KEY_CHAT = chat("4c5d6e7f-0000-4000-8000-000000000004", "Connect the payments API", [SECRET], { provider: "codex" });

function fakeDaemon(chats, { reject } = {}) {
  const log = { answered: [] };
  const agent = (c) => ({
    agent: {
      id: c.id,
      title: c.title,
      status: c.status,
      requiresAttention: true,
      attentionReason: "permission",
      pendingPermissions: c.permissions,
      updatedAt: at(c.minutes),
      createdAt: at(c.minutes + 60),
      archivedAt: null,
      cwd: "/Users/r/lab",
      provider: c.provider ?? "claude",
      currentModeId: "default",
    },
    project: { projectName: c.project, workspaceName: c.project },
  });
  return {
    log,
    async fetchAgents() {
      return { entries: chats.map(agent) };
    },
    async fetchAgent(identifier) {
      const found = chats.filter((c) => c.id.startsWith(identifier));
      return found.length === 1 ? agent(found[0]) : null;
    },
    async respondToPermissionAndWait(agentId, requestId, response) {
      if (reject) throw new Error(reject);
      log.answered.push({ agentId, requestId, response });
      return { agentId, requestId, resolution: response };
    },
    async waitForFinish() {
      return { status: "idle", lastMessage: "Releasing 0.4 now." };
    },
  };
}

test("read_approval gives every question with its numbered options, the recommended ones marked, and the tool that answers it", async () => {
  const { text, data } = await readApprovalOn(fakeDaemon([ASKING, PLAIN]), { chat: ASKING.id });
  assert.equal(data.chat.id, ASKING.id);
  assert.equal(data.chat.state, "waiting for an answer: 2 questions: Release, Daemon");
  const [request] = data.requests;
  assert.deepEqual({ id: request.id, n: request.n, kind: request.kind, what: request.what, answer_with: request.answer_with }, {
    id: "permission-7d1e",
    n: 1,
    kind: "question",
    what: "2 questions: Release, Daemon",
    answer_with: "answer_questions",
  });
  assert.deepEqual(request.questions.map((q) => [q.n, q.header, q.options.map((o) => [o.n, o.label, o.recommended])]), [
    [1, "Release", [[1, "Continue (Recommended)", true], [2, "Stop", false]]],
    [2, "Daemon", [[1, "Leave it (Recommended)", true], [2, "Install from the tag", false]]],
  ]);
  assert.match(text, /^Release 0\.4 of the bridge \(lab\): waiting for an answer: 2 questions: Release, Daemon, 5 min ago\nRequest 1: 2 questions: Release, Daemon\. Questions:\n1\. Release: One test failed once/);
  assert.match(text, /\n {3}1\) Continue \(Recommended\) — Release with a note on the flaky test\.\n {3}2\) Stop\n {3}or an answer in the user's own words\n2\. Daemon: /);
  assert.match(text, /never choose for them, not even the recommended option\.$/);
  const plain = await readApprovalOn(fakeDaemon([ASKING, PLAIN]), { chat: "Publish the package" });
  assert.deepEqual(plain.data.requests, [{ id: "perm-1", n: 1, kind: "tool", what: "run: npm publish", answer_with: "answer_approval", actions: [{ label: "Allow", behavior: "allow" }] }]);
  assert.match(plain.text, /\nRequest 1: run: npm publish \(allow or deny with answer_approval\)$/);
});

test("answer_questions sends the user's choices as Paseo's form does, then tells what the agent did", async () => {
  const daemon = fakeDaemon([ASKING]);
  const result = await answerQuestionsOn(daemon, {
    chat: ASKING.id,
    request: "permission-7d1e",
    answers: [
      { question: "1", options: ["1"] },
      { question: "2", options: ["2"] },
    ],
    waitSeconds: 5,
  });
  assert.deepEqual(daemon.log.answered, [
    {
      agentId: ASKING.id,
      requestId: "permission-7d1e",
      response: { behavior: "allow", updatedInput: { ...RELEASE.input, answers: { Release: "Continue (Recommended)", Daemon: "Install from the tag" } } },
    },
  ]);
  assert.equal(result.data.delivered, true);
  assert.equal(result.data.outcome, "replied");
  assert.equal(result.data.reply, "Releasing 0.4 now.");
  assert.deepEqual(result.data.answered.map((a) => [a.header, a.answer]), [
    ["Release", "Continue (Recommended)"],
    ["Daemon", "Install from the tag"],
  ]);
  assert.match(result.text, /^Answered Release 0\.4 of the bridge \(Release: Continue \(Recommended\); Daemon: Install from the tag\); it arrived\. Do not send it again\.\n/);
});

test("nothing is sent for answers that leave a question out or name what is not there, and the questions come back", async () => {
  const daemon = fakeDaemon([ASKING]);
  const result = await answerQuestionsOn(daemon, { chat: ASKING.id, request: "permission-7d1e", answers: [{ question: "1", options: ["1"] }] });
  assert.equal(result.data.outcome, "invalid_answers");
  assert.equal(result.data.delivered, false);
  assert.deepEqual(result.data.problems, ["question 2 (Daemon) has no answer yet: ask the user; its options: 1) Leave it (Recommended), 2) Install from the tag."]);
  assert.equal(result.data.questions.length, 2);
  assert.match(result.text, /^Nothing was sent to Release 0\.4 of the bridge:\n- question 2 \(Daemon\) has no answer yet/);
  assert.deepEqual(daemon.log.answered, []);
});

test("a request that is gone, asks no questions or asks for a secret gets nothing", async () => {
  const daemon = fakeDaemon([ASKING, PLAIN, KEY_CHAT]);
  const answers = [{ question: "1", options: ["1"] }];
  const gone = await answerQuestionsOn(daemon, { chat: ASKING.id, request: "permission-old", answers });
  assert.deepEqual([gone.data.outcome, gone.data.delivered], ["gone", false]);
  assert.match(gone.text, /Read it again with read_approval before answering\.$/);
  const plain = await answerQuestionsOn(daemon, { chat: PLAIN.id, request: "perm-1", answers });
  assert.deepEqual([plain.data.outcome, plain.data.delivered], ["not_questions", false]);
  const secret = await answerQuestionsOn(daemon, { chat: KEY_CHAT.id, request: SECRET.id, answers: [{ question: "1", text: "sk-…" }] });
  assert.deepEqual([secret.data.outcome, secret.data.reason], ["unsupported", "it asks for a secret, which must not go through ChatGPT"]);
  assert.deepEqual(daemon.log.answered, []);
  const read = await readApprovalOn(daemon, { chat: KEY_CHAT.id });
  assert.equal(read.data.requests[0].answer_with, "paseo");
  assert.match(read.text, /God Mode cannot answer it: it asks for a secret, which must not go through ChatGPT; the user answers it in Paseo\./);
});

test("Codex's question: several options go joined by header, which Paseo turns into Codex's answers", async () => {
  const daemon = fakeDaemon([CODEX_CHAT]);
  await answerQuestionsOn(daemon, { chat: CODEX_CHAT.id, request: CODEX_ASK.id, answers: [{ question: "Scope", options: ["API", "3"] }], waitSeconds: 0 });
  assert.deepEqual(daemon.log.answered[0].response, { behavior: "allow", updatedInput: { ...CODEX_ASK.input, answers: { Scope: "API, Tests" } } });
});

test("answer_approval allows no question request: Claude would refuse it and Codex would take the first options; deny dismisses it", async () => {
  for (const target of [ASKING, CODEX_CHAT]) {
    const daemon = fakeDaemon([target]);
    const result = await answerApprovalOn(daemon, { chat: target.id, decision: "allow" });
    assert.deepEqual([result.data.done, result.data.kind], [false, "question"], target.title);
    assert.match(result.text, /so it takes answers, not "allow": nothing was answered\. Read them with read_approval/);
    assert.deepEqual(daemon.log.answered, [], `${target.title}: nothing sent`);
  }
  const daemon = fakeDaemon([ASKING]);
  const denied = await answerApprovalOn(daemon, { chat: ASKING.id, decision: "deny" });
  assert.deepEqual([denied.data.done, denied.data.decision], [true, "deny"]);
  assert.deepEqual(daemon.log.answered[0].response, { behavior: "deny", message: "Denied by voice." });
  const allowed = await answerApprovalOn(fakeDaemon([PLAIN]), { chat: PLAIN.id, decision: "allow" });
  assert.deepEqual([allowed.data.done, allowed.data.kind], [true, "tool"], "a plain request is allowed as before");
});

test("a request Paseo turns down is an error, never a delivery", async () => {
  const daemon = fakeDaemon([ASKING], { reject: "Permission request 'permission-7d1e' requires updatedInput.answers keyed by a question's full text or header" });
  await assert.rejects(answerQuestionsOn(daemon, { chat: ASKING.id, request: "permission-7d1e", answers: [{ question: "1", options: ["1"] }, { question: "2", options: ["1"] }] }), /requires updatedInput\.answers/);
});
