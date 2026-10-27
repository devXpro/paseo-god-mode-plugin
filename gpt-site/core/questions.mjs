// Questions an agent asks the user through Paseo: Claude's AskUserQuestion, and Codex's
// request_user_input and asynchronous questions. Paseo hands each over as a pending request of kind
// "question" whose input carries the questions, and its own app answers it with a form: an option,
// several where the question allows them, or the user's own words where it takes them. This module
// reads that form and fills it as the form does (QuestionFormCard in Paseo's app): answers keyed by
// each question's header, options by their label, several joined with ", ". Paseo maps those to what
// each agent takes: Claude's answers by question text, Codex's by header. Pure, so the eval stub runs
// it too.
import { chatData, chatLine, describePermission, normalize, truncate } from "./text.mjs";

// Claude marks the option it recommends in its label: "Continue (Recommended)".
const RECOMMENDED = /\s*\(recommended\)\s*/i;

// The questions of a pending request as Paseo's form reads them, numbered from 1, or null when it has
// none or a malformed one; then God Mode cannot fill the form, and the user answers in Paseo.
export function parseQuestions(input) {
  if (!input || typeof input !== "object" || !Array.isArray(input.questions)) return null;
  const questions = [];
  for (const [i, q] of input.questions.entries()) {
    if (!q || typeof q !== "object" || typeof q.question !== "string" || typeof q.header !== "string" || !Array.isArray(q.options)) return null;
    const options = [];
    for (const [j, o] of q.options.entries()) {
      if (!o || typeof o !== "object" || typeof o.label !== "string") return null;
      options.push({ n: j + 1, label: o.label, description: typeof o.description === "string" ? o.description : null, recommended: RECOMMENDED.test(o.label) });
    }
    questions.push({
      n: i + 1,
      header: q.header,
      question: q.question,
      options,
      multiSelect: q.multiSelect === true,
      // Where Paseo's form shows a text box for the user's own words.
      ownWords: options.length === 0 || q.allowOther === true || q.isOther === true,
      allowEmpty: q.allowEmpty === true,
      // Codex asks for a secret this way (a key, a password): never through ChatGPT.
      secret: q.isSecret === true,
    });
  }
  return questions.length > 0 ? questions : null;
}

// Why God Mode cannot fill a question request, or null when it can.
export function cannotFill(permission, questions = parseQuestions(permission.input)) {
  if (!questions) return "its form is not one God Mode can read";
  if (questions.some((q) => q.secret)) return "it asks for a secret, which must not go through ChatGPT";
  // Paseo keys the answers by header, so questions that share one cannot be told apart.
  if (new Set(questions.map((q) => q.header)).size !== questions.length) return "two of its questions share a header";
  return null;
}

// The structured form of a question, for read_approval and the problems of answer_questions.
export function questionData(q) {
  return {
    n: q.n,
    header: q.header,
    question: q.question,
    multi_select: q.multiSelect,
    own_words: q.ownWords,
    options: q.options.map((o) => ({ n: o.n, label: o.label, description: o.description, recommended: o.recommended })),
  };
}

// A question in words, as the user should hear it: header and question, then the numbered options
// with the recommended one marked.
export function questionLines(q) {
  const many = q.multiSelect ? " (several can be chosen)" : "";
  return [
    `${q.n}. ${q.header}: ${q.question}${many}`,
    ...q.options.map((o) => `   ${o.n}) ${o.label}${o.description ? ` — ${truncate(o.description, 160)}` : ""}`),
    q.ownWords && q.options.length ? "   or an answer in the user's own words" : null,
    q.ownWords && !q.options.length ? "   answered in the user's own words" : null,
  ].filter(Boolean);
}

const isNumber = (value) => /^\d+$/.test(String(value ?? "").trim());

// The question a reference names: its number, its header or its whole text.
function findQuestion(questions, ref) {
  if (isNumber(ref)) return questions.find((q) => q.n === Number(String(ref).trim())) ?? null;
  const said = normalize(ref);
  if (!said) return null;
  const named = questions.filter((q) => normalize(q.header) === said || normalize(q.question) === said);
  return named.length === 1 ? named[0] : null;
}

// The option a reference names: its number, its label, or its label without "(Recommended)".
function findOption(q, ref) {
  if (isNumber(ref)) return q.options.find((o) => o.n === Number(String(ref).trim())) ?? null;
  const said = normalize(ref);
  if (!said) return null;
  const named = q.options.filter((o) => normalize(o.label) === said || normalize(o.label.replace(RECOMMENDED, " ")) === said);
  return named.length === 1 ? named[0] : null;
}

const nameOf = (q) => `question ${q.n} (${truncate(q.header, 40)})`;
const choicesOf = (q) => (q.options.length ? q.options.map((o) => `${o.n}) ${truncate(o.label, 60)}`).join(", ") : "no options");

// Fills the form from the user's choices: one entry {question, options?, text?} per question, the
// question by number or header, the options by number or label. As in Paseo's form, every question
// needs an answer, one option unless it allows several, and own words only where it takes them; an
// option or own words for a single choice, not both. Nothing is guessed: whatever is missing, unknown
// or twice comes back in problems, and then nothing is to be sent. Otherwise { answers, answered }:
// answers keyed by header for updatedInput, answered as the user should hear it back.
export function fillAnswers(questions, given) {
  const problems = [];
  const picked = new Map();
  const broken = new Set();
  for (const entry of Array.isArray(given) ? given : []) {
    const q = findQuestion(questions, entry?.question);
    if (!q) {
      problems.push(`There is no question ${JSON.stringify(entry?.question ?? null)}; the questions: ${questions.map((x) => `${x.n} (${x.header})`).join(", ")}.`);
      continue;
    }
    if (picked.has(q.n) || broken.has(q.n)) {
      problems.push(`${nameOf(q)} is answered twice.`);
      broken.add(q.n);
      continue;
    }
    const before = problems.length;
    const labels = [];
    for (const ref of Array.isArray(entry.options) ? entry.options : []) {
      const option = findOption(q, ref);
      if (!option) problems.push(`${nameOf(q)} has no option ${JSON.stringify(ref)}; its options: ${choicesOf(q)}.`);
      else if (!labels.includes(option.label)) labels.push(option.label);
    }
    const text = typeof entry.text === "string" ? entry.text.trim() : "";
    if (text && !q.ownWords) problems.push(`${nameOf(q)} takes only its options, not the user's own words; its options: ${choicesOf(q)}.`);
    if (!q.multiSelect && labels.length > 1) problems.push(`${nameOf(q)} takes one option, not ${labels.length}.`);
    if (!q.multiSelect && labels.length && text) problems.push(`${nameOf(q)} takes an option or the user's own words, not both.`);
    if (problems.length > before) broken.add(q.n);
    else picked.set(q.n, { labels, text });
  }
  const answers = {};
  const answered = [];
  for (const q of questions) {
    if (broken.has(q.n)) continue;
    const choice = picked.get(q.n);
    let value = null;
    if (choice?.text) value = q.multiSelect ? [...choice.labels, choice.text].join(", ") : choice.text;
    else if (choice?.labels.length) value = choice.labels.join(", ");
    else if (q.allowEmpty && q.options.length === 0) value = "";
    if (value === null) {
      problems.push(`${nameOf(q)} has no answer yet: ask the user; its options: ${choicesOf(q)}.`);
      continue;
    }
    answers[q.header] = value;
    answered.push({ n: q.n, header: q.header, question: q.question, answer: value });
  }
  return problems.length ? { problems } : { answers, answered };
}

// ---- read_approval and answer_questions ------------------------------------------------------------

// What read_approval says of one pending request: its kind, and the tool that answers it.
export function requestData(permission, n) {
  const questions = permission.kind === "question" ? parseQuestions(permission.input) : null;
  const why = permission.kind === "question" ? cannotFill(permission, questions) : null;
  return {
    id: permission.id,
    n,
    kind: permission.kind,
    what: describePermission(permission, 300),
    answer_with: permission.kind !== "question" ? "answer_approval" : why ? "paseo" : "answer_questions",
    ...(why ? { why } : {}),
    ...(questions ? { questions: questions.map(questionData) } : {}),
    ...(permission.actions?.length ? { actions: permission.actions.map((a) => ({ label: a.label, behavior: a.behavior })) } : {}),
  };
}

function requestLines(permission, n) {
  const data = requestData(permission, n);
  const head = `Request ${n}: ${data.what}`;
  if (data.answer_with === "answer_approval") return [`${head} (allow or deny with answer_approval)`];
  if (data.answer_with === "paseo") return [`${head}. God Mode cannot answer it: ${data.why}; the user answers it in Paseo.`];
  return [`${head}. Questions:`, ...parseQuestions(permission.input).flatMap(questionLines)];
}

// read_approval's answer: every request the chat waits on, questions and options in full.
export function approvalResult(chat, now = Date.now()) {
  const data = { chat: chatData(chat, now), requests: chat.permissions.map((p, i) => requestData(p, i + 1)) };
  if (chat.permissions.length === 0) {
    return { text: `${chatLine(chat, now)}\nIt waits on no request. If the agent asked a question in its text, answer it with send_message.`, data };
  }
  const lines = [chatLine(chat, now), ...chat.permissions.flatMap((p, i) => requestLines(p, i + 1))];
  if (data.requests.some((r) => r.answer_with === "answer_questions")) {
    lines.push("Read each question and its options to the user. Send only the options they choose, every question answered, with answer_questions; never choose for them, not even the recommended option.");
  }
  return { text: lines.join("\n"), data };
}

// answer_approval's answer to "allow" on a question request, which sends nothing: questions take
// answers, not a yes. Claude refuses an allow without them, and Codex would take the first option of
// every question.
export function questionsNeedAnswers(chat, permission, now = Date.now()) {
  const what = describePermission(permission);
  return {
    text: `${chatLine(chat, now)}\nIt asks the user questions (${what}), so it takes answers, not "allow": nothing was answered. Read them with read_approval, tell the user each question with its options, and send the options they choose with answer_questions.`,
    data: { chat_id: chat.id, done: false, kind: permission.kind, what },
  };
}

// answer_questions before anything is sent: the request must still be the one read_approval gave
// (by id), ask questions God Mode can fill, and the answers fill its every question. Returns
// { refused: {text, data} } when nothing is to be sent, else { permission, filled }.
export function prepareAnswers(chat, request, answers) {
  const title = truncate(chat.title, 70);
  const ids = { chat_id: chat.id, short_id: chat.id.slice(0, 7), project: chat.project, request };
  const refuse = (outcome, text, more = {}) => ({ refused: { text, data: { ...ids, outcome, delivered: false, ...more } } });
  const permission = chat.permissions.find((p) => p.id === request);
  if (!permission) {
    return refuse("gone", `Nothing was sent: ${title} no longer waits on that request; it was answered, withdrawn or replaced. Read it again with read_approval before answering.`);
  }
  if (permission.kind !== "question") {
    return refuse("not_questions", `Nothing was sent: that request of ${title} asks no questions (${describePermission(permission)}); allow or deny it with answer_approval.`);
  }
  const questions = parseQuestions(permission.input);
  const why = cannotFill(permission, questions);
  if (why) return refuse("unsupported", `Nothing was sent: God Mode cannot answer this request of ${title}: ${why}. The user answers it in Paseo.`, { reason: why });
  const filled = fillAnswers(questions, answers);
  if (filled.problems) {
    return refuse(
      "invalid_answers",
      [`Nothing was sent to ${title}:`, ...filled.problems.map((p) => `- ${p}`), "Ask the user, then call again with every question answered. The questions:", ...questions.flatMap(questionLines)].join("\n"),
      { problems: filled.problems, questions: questions.map(questionData) },
    );
  }
  return { permission, filled };
}

// The response Paseo's form sends for these answers: allow, with the request's input and the answers.
export const answerResponse = (permission, filled) => ({ behavior: "allow", updatedInput: { ...permission.input, answers: filled.answers } });

// answer_questions' answer once the answers arrived: what was sent, and what the agent did next
// (outcome, as awaitReply gives it).
export function answeredResult(chat, request, filled, outcome) {
  const said = filled.answered.map((a) => `${a.header}: ${a.answer}`).join("; ");
  return {
    text: `Answered ${truncate(chat.title, 70)} (${said}); it arrived. Do not send it again.\n${outcome.text}`,
    data: { chat_id: chat.id, short_id: chat.id.slice(0, 7), project: chat.project, request, answered: filled.answered, ...outcome.data },
  };
}
