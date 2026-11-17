import assert from "node:assert/strict";
import { test } from "node:test";
import { DECIDE_SOURCE, claudeAxScript } from "./claude-ax.ts";

interface Node {
  i: number;
  parent: number;
  role: string;
  subrole?: string;
  label?: string;
  title?: string;
  value?: string;
  url?: string;
  enabled?: boolean;
  focused?: boolean;
  hasText?: boolean;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
}
interface Decision {
  action: "press" | "active" | "none";
  index?: number;
  label?: string;
  why?: string;
  reason?: string;
  screen?: string;
  newChat?: number;
}

const { decide } = new Function(`${DECIDE_SOURCE}; return { decide };`)() as { decide: (s: { nodes: Node[]; url: string }) => Decision };

/**
 * A claude.ai window as the Accessibility tree of the desktop app showed it (2026-11-17): a sidebar
 * with a "New chat" link, a message list with its own buttons, and the composer: the message box with
 * the send button at its right, and below it a row of icons (attachments, dictation, voice mode).
 * `buttons` are that row, left to right.
 */
function window(options: { buttons: Partial<Node>[]; draft?: string; url?: string; focused?: boolean; send?: string | null; link?: boolean; extra?: Partial<Node>[] }) {
  const nodes: Node[] = [];
  const add = (n: Partial<Node> & { role: string; parent: number }) => {
    const node = { w: 0, h: 0, x: 0, y: 0, ...n, i: nodes.length } as Node;
    nodes.push(node);
    return node.i;
  };
  const area = add({ role: "AXWebArea", parent: -1 });
  const sidebar = add({ role: "AXGroup", parent: area });
  if (options.link !== false) add({ role: "AXLink", parent: sidebar, label: "", url: "https://claude.ai/new", x: 355, y: 90, w: 268, h: 32 });
  add({ role: "AXButton", parent: sidebar, label: "Close sidebar", x: 355, y: 41, w: 28, h: 28 });
  const list = add({ role: "AXGroup", parent: area });
  add({ role: "AXButton", parent: list, label: "Copy", x: 753, y: 561, w: 24, h: 25 });
  add({ role: "AXButton", parent: list, label: "Read aloud", x: 777, y: 561, w: 24, h: 25 });
  add({ role: "AXButton", parent: list, label: "Retry", x: 849, y: 561, w: 24, h: 25 });
  const composer = add({ role: "AXGroup", parent: area });
  const top = add({ role: "AXGroup", parent: composer });
  const box = add({ role: "AXGroup", parent: top });
  add({ role: "AXTextArea", parent: box, label: "Write your prompt to Claude", value: options.draft ?? "", focused: options.focused ?? true, x: 753, y: 951, w: 710, h: 21 });
  const send = options.send === undefined ? "Send message" : options.send;
  if (send) add({ role: "AXButton", parent: top, label: send, x: 1471, y: 947, w: 28, h: 28 });
  const row = add({ role: "AXGroup", parent: composer });
  let x = 746;
  for (const b of options.buttons) {
    add({ role: "AXButton", parent: row, x, y: 991, w: 24, h: 24, ...b });
    x += 28;
  }
  for (const e of options.extra ?? []) add({ parent: area, ...e } as Node);
  return { nodes, url: options.url ?? "https://claude.ai/new" };
}

const attach = { label: "Add files and more" };
const dictate = { label: "Dictate" };
const voice = (label: string) => ({ label });
const pressedLabel = (s: ReturnType<typeof window>, d: Decision) => (d.action === "press" ? s.nodes[d.index as number].label : null);

test("the English voice mode button is pressed by its label", () => {
  const s = window({ buttons: [attach, dictate, voice("Use voice mode")] });
  const d = decide(s);
  assert.equal(d.action, "press");
  assert.equal(pressedLabel(s, d), "Use voice mode");
  assert.equal(d.why, "label");
});

test("a Russian or Ukrainian interface is recognised too", () => {
  for (const label of ["Включить голосовой режим", "Использовать голосовой режим", "Голосовой режим", "Голосовий режим"]) {
    const s = window({ send: "Отправить сообщение", buttons: [{ label: "Добавить файлы" }, { label: "Диктовать" }, voice(label)] });
    assert.equal(pressedLabel(s, decide(s)), label, label);
  }
});

test("a voice label we do not know is still found right after the dictation button", () => {
  const s = window({ buttons: [attach, dictate, voice("Talk with Claude")] });
  const d = decide(s);
  assert.equal(pressedLabel(s, d), "Talk with Claude");
  assert.equal(d.why, "next to dictation");
  const ru = window({ send: "Отправить сообщение", buttons: [{ label: "Добавить файлы" }, { label: "Диктовать" }, voice("Поговорить с Claude")] });
  assert.equal(decide(ru).why, "next to dictation");
});

test("an interface language we do not know at all presses nothing, least of all send", () => {
  const s = window({ send: "Envoyer le message", buttons: [{ label: "Fichiers" }, { label: "Dicter" }, voice("Utiliser le mode X")] });
  assert.equal(decide(s).action, "none");
});

test("dictation is never mistaken for voice mode", () => {
  const s = window({ buttons: [attach, dictate] });
  assert.equal(decide(s).action, "none");
  const ru = window({ buttons: [attach, { label: "Голосовой ввод" }] });
  assert.equal(decide(ru).action, "none");
});

test("with a draft the send button holds the spot and nothing is pressed", () => {
  const s = window({ draft: "привет", buttons: [attach, dictate] });
  const d = decide(s);
  assert.equal(d.action, "none");
  assert.equal(d.reason, "draft");
  assert.equal(s.nodes[d.newChat as number].url, "https://claude.ai/new");
});

test("send, stop and the message list's own buttons are never pressed", () => {
  for (const label of ["Send message", "Stop response", "Отправить сообщение", "Остановить"]) {
    const s = window({ send: label, buttons: [attach, dictate, { label }] });
    assert.equal(decide(s).action, "none", label);
  }
  const reading = window({ buttons: [attach, dictate] });
  assert.equal(decide(reading).action, "none", "Read aloud is not voice mode");
});

test("voice already on is reported, not toggled off", () => {
  const s = window({ buttons: [{ label: "Turn off microphone" }, { label: "End voice mode" }] });
  assert.equal(decide(s).action, "active");
  const ru = window({ buttons: [{ label: "Выключить микрофон" }] });
  assert.equal(decide(ru).action, "active");
});

test("a label repeated as the title is read once", () => {
  const s = window({ buttons: [attach, dictate, { label: "Use voice mode", title: "Use voice mode" }] });
  assert.equal(decide(s).label, "Use voice mode");
});

test("the button is found when the message box is not focused", () => {
  const s = window({ focused: false, buttons: [attach, dictate, voice("Use voice mode")] });
  assert.equal(pressedLabel(s, decide(s)), "Use voice mode");
});

test("a labelled voice button elsewhere still wins over position", () => {
  const s = window({
    buttons: [attach, { label: "Fichiers" }],
    extra: [{ role: "AXButton", label: "Use voice mode", x: 50, y: 400, w: 30, h: 30 }],
  });
  assert.equal(pressedLabel(s, decide(s)), "Use voice mode");
});

test("Claude Code or Cowork has no composer button for voice: open a new chat", () => {
  const s = window({ url: "https://claude.ai/code/abc", buttons: [attach] });
  const d = decide(s);
  assert.equal(d.action, "none");
  assert.equal(d.screen, "elsewhere");
  assert.ok((d.newChat as number) >= 0);
});

test("no window content at all says there is no composer", () => {
  const d = decide({ nodes: [{ i: 0, parent: -1, role: "AXWebArea" }], url: "https://claude.ai/settings" });
  assert.equal(d.action, "none");
  assert.equal(d.reason, "no-composer");
  assert.equal(d.newChat, -1);
});

test("disabled buttons are skipped", () => {
  const s = window({ buttons: [attach, dictate, { ...voice("Use voice mode"), enabled: false }] });
  assert.equal(decide(s).action, "none");
});

test("the whole JXA program parses and defines run()", () => {
  const script = claudeAxScript();
  assert.doesNotThrow(() => new Function(script));
  assert.match(script, /function run\(argv\)/);
});

test("on a chat with a draft, the sidebar's New chat button opens a new chat", () => {
  const s = window({ url: "https://claude.ai/chat/abc", link: false, draft: "черновик", buttons: [attach, dictate], extra: [{ role: "AXButton", title: "Создать", x: 355, y: 82, w: 268, h: 32 }] });
  const d = decide(s);
  assert.equal(d.reason, "draft");
  assert.equal(s.nodes[d.newChat as number].title, "Создать");
});

test("on Claude Code's screen its Create button is not taken for a new chat", () => {
  const s = window({ url: "https://claude.ai/epitaxy", link: false, buttons: [attach], extra: [{ role: "AXButton", title: "Создать", x: 447, y: 290, w: 268, h: 32 }] });
  const d = decide(s);
  assert.equal(d.screen, "elsewhere");
  assert.equal(d.newChat, -1);
});
