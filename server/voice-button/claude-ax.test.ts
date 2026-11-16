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
 * A claude.ai window as the Accessibility tree shows it: a sidebar with a "New chat" link, a message
 * list, and the composer (a text box with its buttons below it). `buttons` are the composer's, left to right.
 */
function window(options: { buttons: Partial<Node>[]; draft?: string; url?: string; focused?: boolean; extra?: Partial<Node>[] }) {
  const nodes: Node[] = [];
  const add = (n: Partial<Node> & { role: string; parent: number }) => {
    const node = { w: 0, h: 0, x: 0, y: 0, ...n, i: nodes.length } as Node;
    nodes.push(node);
    return node.i;
  };
  const area = add({ role: "AXWebArea", parent: -1 });
  const sidebar = add({ role: "AXGroup", parent: area });
  add({ role: "AXLink", parent: sidebar, label: "", url: "https://claude.ai/new", x: 10, y: 60, w: 200, h: 30 });
  add({ role: "AXButton", parent: sidebar, label: "Close sidebar", x: 10, y: 10, w: 30, h: 30 });
  const list = add({ role: "AXGroup", parent: area });
  add({ role: "AXButton", parent: list, label: "Copy", x: 400, y: 300, w: 30, h: 30 });
  add({ role: "AXButton", parent: list, label: "Retry", x: 440, y: 300, w: 30, h: 30 });
  const composer = add({ role: "AXGroup", parent: area });
  const box = add({ role: "AXGroup", parent: composer });
  add({ role: "AXTextArea", parent: box, value: options.draft ?? "", focused: options.focused ?? true, x: 300, y: 800, w: 700, h: 60 });
  const row = add({ role: "AXGroup", parent: composer });
  let x = 300;
  for (const b of options.buttons) {
    add({ role: "AXButton", parent: row, x, y: 870, w: 32, h: 32, ...b });
    x += b.x === undefined ? 40 : 0;
  }
  for (const e of options.extra ?? []) add({ parent: area, ...e } as Node);
  return { nodes, url: options.url ?? "https://claude.ai/new" };
}

const attach = { label: "Add files and more" };
const tools = { label: "Tools" };
const model = { label: "Opus 5.5", hasText: true, x: 800 };
const dictate = { label: "Dictate", x: 900 };
const voice = (label: string) => ({ label, x: 960 });
const pressedLabel = (s: ReturnType<typeof window>, d: Decision) => (d.action === "press" ? s.nodes[d.index as number].label : null);

test("the English voice mode button is pressed by its label", () => {
  const s = window({ buttons: [attach, tools, model, dictate, voice("Use voice mode")] });
  const d = decide(s);
  assert.equal(d.action, "press");
  assert.equal(pressedLabel(s, d), "Use voice mode");
  assert.equal(d.why, "label");
});

test("a Russian or Ukrainian interface is recognised too", () => {
  for (const label of ["Использовать голосовой режим", "Голосовой режим", "Голосовий режим"]) {
    const s = window({ buttons: [{ label: "Добавить файлы" }, { label: "Диктовка", x: 900 }, voice(label)] });
    assert.equal(pressedLabel(s, decide(s)), label, label);
  }
});

test("an unknown interface language falls back to the send spot of an empty composer", () => {
  const s = window({ buttons: [{ label: "Fichiers" }, { label: "Outils" }, voice("Utiliser le mode X")] });
  const d = decide(s);
  assert.equal(pressedLabel(s, d), "Utiliser le mode X");
  assert.equal(d.why, "send spot of an empty composer");
});

test("dictation is never mistaken for voice mode", () => {
  const s = window({ buttons: [attach, { label: "Dictate", x: 960 }] });
  assert.equal(decide(s).action, "none");
  const ru = window({ buttons: [attach, { label: "Голосовой ввод", x: 960 }] });
  assert.equal(decide(ru).action, "none");
});

test("with a draft the send button holds the spot and nothing is pressed", () => {
  const s = window({ draft: "привет", buttons: [attach, dictate, { label: "Send message", x: 960 }] });
  const d = decide(s);
  assert.equal(d.action, "none");
  assert.equal(d.reason, "draft");
  assert.equal(s.nodes[d.newChat as number].url, "https://claude.ai/new");
});

test("a send or stop button in the spot is never pressed, even unlabelled in a known way", () => {
  for (const label of ["Send message", "Stop response", "Отправить сообщение", "Остановить"]) {
    const s = window({ buttons: [attach, { label, x: 960 }] });
    assert.equal(decide(s).action, "none", label);
  }
});

test("voice already on is reported, not toggled off", () => {
  const s = window({ buttons: [{ label: "Turn off microphone" }, { label: "End voice mode", x: 960 }] });
  assert.equal(decide(s).action, "active");
  const ru = window({ buttons: [{ label: "Выключить микрофон" }] });
  assert.equal(decide(ru).action, "active");
});

test("the button is found when the message box is not focused", () => {
  const s = window({ focused: false, buttons: [attach, dictate, voice("Use voice mode")] });
  assert.equal(pressedLabel(s, decide(s)), "Use voice mode");
});

test("a labelled voice button elsewhere still wins over position", () => {
  const s = window({
    buttons: [attach, { label: "Fichiers", x: 960 }],
    extra: [{ role: "AXButton", label: "Use voice mode", x: 50, y: 400, w: 30, h: 30 }],
  });
  assert.equal(pressedLabel(s, decide(s)), "Use voice mode");
});

test("Claude Code or Cowork has no composer button for voice: open a new chat", () => {
  const s = window({ url: "https://claude.ai/code/abc", buttons: [attach, { label: "Send", x: 960 }] });
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
  const s = window({ buttons: [attach, { ...voice("Use voice mode"), enabled: false }] });
  assert.equal(decide(s).action, "none");
});

test("the whole JXA program parses and defines run()", () => {
  const script = claudeAxScript();
  assert.doesNotThrow(() => new Function(script));
  assert.match(script, /function run\(argv\)/);
});
