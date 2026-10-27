// Run with: node --test core/
// Reading and filling the question forms agents put to the user, in the shapes Paseo 0.13 gives them:
// Claude's AskUserQuestion (allowOther added by Paseo), Codex's request_user_input (ids, isOther,
// isSecret) and Codex's asynchronous questions (headers "Question N"). The answers must be what
// Paseo's own form would send.
import assert from "node:assert/strict";
import { test } from "node:test";
import { cannotFill, fillAnswers, parseQuestions, questionData, questionLines } from "./questions.mjs";

// Two questions, each with the option Claude recommends, as a release check asks them.
const CLAUDE = {
  questions: [
    {
      header: "Release",
      question: "One test failed once and passed three times after. Continue the release?",
      multiSelect: false,
      allowOther: true,
      options: [
        { label: "Continue (Recommended)", description: "Note the flaky test in the release notes and release." },
        { label: "Stop", description: "Look into the flaky test first." },
      ],
    },
    {
      header: "Daemon",
      question: "Install the daemon from the tag after the release?",
      multiSelect: false,
      allowOther: true,
      options: [{ label: "Leave it (Recommended)" }, { label: "Install from the tag" }],
    },
  ],
};
const CODEX = {
  questions: [
    { id: "scope", header: "Scope", question: "Which parts should the refactor touch?", multiSelect: true, options: [{ label: "API" }, { label: "UI" }, { label: "Tests" }] },
    { id: "name", header: "Name", question: "What should the new module be called?", isOther: true, options: [] },
  ],
};
// Codex's asynchronous questions: Paseo numbers them and lets the user answer in words.
const ASYNC = { questions: [{ id: "0", header: "Question 1", question: "Keep the old flag?", options: [{ label: "yes" }, { label: "no" }], isOther: true }] };

test("Claude's questions read with their numbered options, the recommended ones marked", () => {
  const questions = parseQuestions(CLAUDE);
  assert.deepEqual(
    questions.map(questionData),
    [
      {
        n: 1,
        header: "Release",
        question: CLAUDE.questions[0].question,
        multi_select: false,
        own_words: true,
        options: [
          { n: 1, label: "Continue (Recommended)", description: "Note the flaky test in the release notes and release.", recommended: true },
          { n: 2, label: "Stop", description: "Look into the flaky test first.", recommended: false },
        ],
      },
      {
        n: 2,
        header: "Daemon",
        question: "Install the daemon from the tag after the release?",
        multi_select: false,
        own_words: true,
        options: [
          { n: 1, label: "Leave it (Recommended)", description: null, recommended: true },
          { n: 2, label: "Install from the tag", description: null, recommended: false },
        ],
      },
    ],
  );
  assert.deepEqual(questionLines(questions[1]), [
    "2. Daemon: Install the daemon from the tag after the release?",
    "   1) Leave it (Recommended)",
    "   2) Install from the tag",
    "   or an answer in the user's own words",
  ]);
  assert.equal(cannotFill({ kind: "question", input: CLAUDE }), null);
});

test("the user's choices fill the form as Paseo's does: keyed by header, options by label", () => {
  const questions = parseQuestions(CLAUDE);
  const filled = fillAnswers(questions, [
    { question: "1", options: ["1"] },
    { question: "Daemon", options: ["Install from the tag"] },
  ]);
  assert.deepEqual(filled.answers, { Release: "Continue (Recommended)", Daemon: "Install from the tag" });
  assert.deepEqual(
    filled.answered.map((a) => [a.n, a.header, a.answer]),
    [
      [1, "Release", "Continue (Recommended)"],
      [2, "Daemon", "Install from the tag"],
    ],
  );
  // A label said without its "(Recommended)", numbers as numbers, and the user's own words.
  assert.deepEqual(fillAnswers(questions, [{ question: 1, options: ["continue"] }, { question: 2, text: "Only after the weekend" }]).answers, {
    Release: "Continue (Recommended)",
    Daemon: "Only after the weekend",
  });
});

test("nothing is guessed: a question left out, an unknown option or question, two picks for one, and words where none are taken", () => {
  const questions = parseQuestions(CLAUDE);
  const missing = fillAnswers(questions, [{ question: "1", options: ["1"] }]);
  assert.equal(missing.answers, undefined);
  assert.deepEqual(missing.problems, ["question 2 (Daemon) has no answer yet: ask the user; its options: 1) Leave it (Recommended), 2) Install from the tag."]);
  assert.match(fillAnswers(questions, [{ question: "1", options: ["3"] }, { question: "2", options: ["1"] }]).problems[0], /^question 1 \(Release\) has no option "3"; its options: 1\) Continue \(Recommended\), 2\) Stop\.$/);
  assert.match(fillAnswers(questions, [{ question: "Version", options: ["1"] }, { question: "1", options: ["1"] }, { question: "2", options: ["1"] }]).problems[0], /^There is no question "Version"; the questions: 1 \(Release\), 2 \(Daemon\)\.$/);
  assert.deepEqual(fillAnswers(questions, [{ question: "1", options: ["1", "2"] }, { question: "2", options: ["1"] }]).problems, ["question 1 (Release) takes one option, not 2."]);
  assert.deepEqual(fillAnswers(questions, [{ question: "1", options: ["1"], text: "and hurry" }, { question: "2", options: ["1"] }]).problems, [
    "question 1 (Release) takes an option or the user's own words, not both.",
  ]);
  assert.deepEqual(fillAnswers(questions, [{ question: "1", options: ["1"] }, { question: "Release", options: ["2"] }, { question: "2", options: ["1"] }]).problems, ["question 1 (Release) is answered twice."]);
  const optionsOnly = parseQuestions({ questions: [{ ...CLAUDE.questions[0], allowOther: false }] });
  assert.match(fillAnswers(optionsOnly, [{ question: "1", text: "maybe" }]).problems[0], /takes only its options, not the user's own words/);
  assert.deepEqual(fillAnswers(questions, []).problems.length, 2, "no answers at all: both questions are asked about");
});

test("Codex's questions: several options joined as Paseo joins them, own words where there are no options", () => {
  const questions = parseQuestions(CODEX);
  assert.deepEqual(questions.map((q) => [q.multiSelect, q.ownWords]), [
    [true, false],
    [false, true],
  ]);
  const filled = fillAnswers(questions, [
    { question: "1", options: ["3", "API"] },
    { question: "Name", text: "billing-core" },
  ]);
  assert.deepEqual(filled.answers, { Scope: "Tests, API", Name: "billing-core" }, "in the order chosen, as Paseo's form keeps them");
  assert.match(fillAnswers(questions, [{ question: "1", options: ["1"] }]).problems[0], /^question 2 \(Name\) has no answer yet: ask the user; its options: no options\.$/);
  assert.equal(cannotFill({ kind: "question", input: CODEX }), null);
  assert.deepEqual(fillAnswers(parseQuestions(ASYNC), [{ question: "1", text: "keep it for one release" }]).answers, { "Question 1": "keep it for one release" });
});

test("a form God Mode cannot fill says why: malformed, a secret, or headers Paseo cannot tell apart", () => {
  assert.equal(parseQuestions({ questions: [{ header: "X", question: "Y", options: [{ text: "no label" }] }] }), null);
  assert.equal(parseQuestions({}), null);
  assert.equal(parseQuestions({ questions: [] }), null);
  assert.equal(cannotFill({ kind: "question", input: { plan: "…" } }), "its form is not one God Mode can read");
  const secret = { questions: [{ id: "key", header: "Key", question: "Paste the API key", isOther: true, isSecret: true, options: [] }] };
  assert.equal(cannotFill({ kind: "question", input: secret }), "it asks for a secret, which must not go through ChatGPT");
  const twins = { questions: [CLAUDE.questions[0], { ...CLAUDE.questions[1], header: "Release" }] };
  assert.equal(cannotFill({ kind: "question", input: twins }), "two of its questions share a header");
});
