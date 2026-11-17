// Finds and presses Claude's voice mode button through macOS Accessibility. Claude's desktop app shows
// claude.ai in an Electron window; its voice button is an icon with an aria-label ("Use voice mode"),
// no test id, sitting in the composer's send spot while the message box is empty. Anthropic publishes no
// link, shortcut or Shortcuts action that starts voice mode, so pressing the button is the only way.
//
// The script runs under `osascript -l JavaScript` (JXA). It is kept as plain JavaScript text in two
// parts: DECIDE_SOURCE is pure (a flat snapshot of the window in, a decision out) and is tested under
// Node; COLLECT_SOURCE reads the Accessibility tree, presses, navigates and verifies.

/**
 * Pure decision logic over a snapshot: `{ nodes, url }`, where each node is
 * `{ i, parent, role, subrole, label, title, value, placeholder, url, enabled, focused, x, y, w, h, hasText }`.
 */
export const DECIDE_SOURCE = String.raw`
var VOICE_STRONG = /\bvoice mode\b|\bvoice chat\b|голосов\S* режим|режим\S* голос|голосов\S* (чат|розмов|разговор)|mode vocal|modo (de )?voz|sprachmodus|modalit[aà] vocale|tryb g[łl]osowy|spraakmodus|音声モード|음성 모드|语音模式|語音模式/i;
var VOICE_WEAK = /\bvoice\b|голос|vocal|\bvoz\b|stimm|g[łl]os/i;
var DICTATION = /dictat|диктов|диктуй|voice input|голосов\S* ввод|transcri/i;
var ACTIVE = /turn (on|off) (the )?microphone|(end|exit|leave|stop) voice|(включить|выключить|отключить|вимкнути|увімкнути) микрофон|(включить|выключить|отключить|вимкнути|увімкнути) мікрофон|заверш\S* голос|выйти из голос/i;
var NEW_CHAT = /^(new chat|start new chat|новый чат|создать|новий чат|створити)$/i;
var DENY = /send|stop|cancel|attach|upload|\badd\b|plus|model|menu|tool|setting|close|copy|retry|edit|share|search|research|style|project|отправ|стоп|останов|отмен|прикреп|загруз|добав|модел|меню|инструмент|настро|закры|копир|повтор|измен|поделит|поиск|стил|проект/i;

/** The label, title and help, each once: Chromium often repeats the aria-label as the title. */
function textOf(n) {
  var out = [];
  [n.label, n.title, n.help].forEach(function (s) {
    s = (s || "").trim();
    if (s && out.indexOf(s) < 0) out.push(s);
  });
  return out.join(" ");
}

function ancestors(nodes, i, limit) {
  var out = [];
  var at = nodes[i] ? nodes[i].parent : -1;
  while (at !== undefined && at >= 0 && out.length < limit) {
    out.push(at);
    at = nodes[at] ? nodes[at].parent : -1;
  }
  return out;
}

/** How many levels up from node i until an ancestor of node j (within limit); -1 when none. */
function distance(nodes, i, j, limit) {
  var up = ancestors(nodes, j, limit);
  var at = i;
  for (var level = 0; level <= limit; level++) {
    if (at === j || up.indexOf(at) >= 0) return level;
    at = nodes[at] ? nodes[at].parent : -1;
    if (at === undefined || at < 0) return -1;
  }
  return -1;
}

function isTextBox(n) {
  return n.role === "AXTextArea" || (n.role === "AXTextField" && n.subrole !== "AXSearchField");
}

/** The message box: the focused text box, else the lowest wide one. */
function pickComposer(nodes) {
  var boxes = nodes.filter(function (n) { return n && isTextBox(n) && n.w > 120; });
  var focused = boxes.filter(function (n) { return n.focused; });
  if (focused.length) return focused[0];
  boxes.sort(function (a, b) { return (b.y + b.h) - (a.y + a.h); });
  return boxes[0] || null;
}

function urlPath(url) {
  var m = /^[a-z]+:\/\/[^\/]+(\/[^?#]*)?/i.exec(url || "");
  return m ? (m[1] || "/") : "";
}

/** Where the window is: "chat" (a new or existing chat), "elsewhere" (Code, Cowork, settings…) or "unknown". */
function screenOf(url) {
  var path = urlPath(url);
  if (!path) return "unknown";
  if (path === "/new" || path === "/" || /^\/chat\//.test(path) || /^\/project\/[^\/]+$/.test(path)) return "chat";
  return "elsewhere";
}

function decide(snapshot) {
  var nodes = snapshot.nodes;
  var buttons = nodes.filter(function (n) { return n && n.role === "AXButton" && n.enabled !== false && n.w > 0 && n.h > 0; });
  for (var a = 0; a < buttons.length; a++) {
    if (ACTIVE.test(textOf(buttons[a]))) return { action: "active", label: textOf(buttons[a]) };
  }
  var composer = pickComposer(nodes);
  var empty = composer ? !(composer.value && String(composer.value).trim()) : false;
  var near = [];
  var candidates = [];
  for (var b = 0; b < buttons.length; b++) {
    var n = buttons[b];
    var text = textOf(n);
    var c = { node: n, text: text, score: 0, inComposer: false, strong: false, weak: false };
    if (composer) {
      var d = distance(nodes, n.i, composer.i, 7);
      if (d >= 0 && d <= 7 && n.y + n.h / 2 >= composer.y - 8) {
        c.inComposer = true;
        near.push(c);
      }
    }
    if (DICTATION.test(text) || ACTIVE.test(text)) continue;
    if (VOICE_STRONG.test(text)) { c.strong = true; c.score += 100; }
    else if (VOICE_WEAK.test(text) && !DENY.test(text)) { c.weak = true; c.score += 40; }
    if (!n.hasText) c.score += 10;
    if (c.inComposer) c.score += 30;
    candidates.push(c);
  }
  candidates.sort(function (x, y) { return y.score - x.score; });
  var best = candidates[0];
  if (best && best.strong) return { action: "press", index: best.node.i, label: best.text, why: "label" };
  if (best && best.weak && best.inComposer) {
    return { action: "press", index: best.node.i, label: best.text, why: "voice word in the composer" };
  }
  // No label we know (another interface language): voice mode sits right after the dictation button,
  // in the same row of the composer, so take the icon there unless it is one of the known others.
  var dictation = near.filter(function (x) { return DICTATION.test(x.text); })[0];
  if (dictation) {
    var row = dictation.node.y + dictation.node.h / 2;
    var next = null;
    for (var r = 0; r < near.length; r++) {
      var o = near[r].node;
      var gap = o.x - (dictation.node.x + dictation.node.w);
      if (o === dictation.node || gap < -2 || gap > 40 || Math.abs(o.y + o.h / 2 - row) > 8) continue;
      if (!next || o.x < next.node.x) next = near[r];
    }
    if (next && !next.node.hasText && next.text && !DENY.test(next.text) && !DICTATION.test(next.text) && !ACTIVE.test(next.text)) {
      return { action: "press", index: next.node.i, label: next.text, why: "next to dictation" };
    }
  }
  // A new chat: a link to /new, or on a chat screen the sidebar's "New chat" ("Создать" in Russian;
  // on Claude Code's screen the same button starts a Code session, so only on a chat).
  var links = nodes.filter(function (n) {
    if (!n || n.w <= 0) return false;
    if (n.role === "AXLink" && urlPath(n.url) === "/new") return true;
    return n.role === "AXButton" && screenOf(snapshot.url) === "chat" && NEW_CHAT.test(textOf(n));
  });
  var reason = !composer ? "no-composer" : !empty ? "draft" : "no-button";
  return {
    action: "none",
    reason: reason,
    screen: screenOf(snapshot.url),
    newChat: links.length ? links[0].i : -1,
    seen: buttons.length,
    labels: near.map(function (x) { return x.text; }).slice(0, 12),
  };
}
`;

/** Reads the tree, presses, navigates to a new chat when needed and checks that voice started. */
export const COLLECT_SOURCE = String.raw`
ObjC.import("ApplicationServices");
ObjC.import("AppKit");

var ATTRS = ["AXRole", "AXSubrole", "AXDescription", "AXTitle", "AXHelp", "AXChildren", "AXEnabled", "AXFocused", "AXPosition", "AXSize", "AXURL", "AXValue", "AXPlaceholderValue"];

function attr(el, name) {
  var ref = Ref();
  return $.AXUIElementCopyAttributeValue(el, $(name), ref) === 0 ? ObjC.castRefToObject(ref[0]) : undefined;
}

function many(el) {
  var ref = Ref();
  if ($.AXUIElementCopyMultipleAttributeValues(el, $(ATTRS), 0, ref) !== 0) return null;
  var arr = ObjC.castRefToObject(ref[0]);
  var out = {};
  for (var i = 0; i < ATTRS.length; i++) {
    var v = arr.objectAtIndex(i);
    out[ATTRS[i]] = v;
  }
  return out;
}

function isAxError(v) {
  try {
    var d = v.description.js;
    return /kAXValueAXErrorType/.test(d);
  } catch (e) {
    return false;
  }
}

function val(raw, name) {
  var v = raw[name];
  if (v === undefined || v === null || isAxError(v)) return undefined;
  return v;
}

function text(v) {
  if (v === undefined) return "";
  try {
    var u = ObjC.unwrap(v);
    if (typeof u === "string") return u;
    if (v.absoluteString) return v.absoluteString.js || "";
  } catch (e) {}
  return "";
}

function geometry(v) {
  if (v === undefined) return null;
  try {
    var d = v.description.js;
    var m = /x:(-?[\d.]+) y:(-?[\d.]+)/.exec(d) || /w:(-?[\d.]+) h:(-?[\d.]+)/.exec(d);
    if (m) return [parseFloat(m[1]), parseFloat(m[2])];
  } catch (e) {}
  return null;
}

var KEEP = { AXButton: 1, AXLink: 1, AXTextArea: 1, AXTextField: 1, AXStaticText: 0 };

/** One pass over a subtree; every visited element gets an index and a parent so the decision can relate them. */
function collect(root, budget) {
  var nodes = [];
  var elements = [];
  var stack = [[root, -1]];
  var visited = 0;
  while (stack.length && visited < budget) {
    var item = stack.pop();
    var el = item[0];
    var raw = many(el);
    if (!raw) continue;
    var i = visited++;
    var role = text(val(raw, "AXRole"));
    var n = { i: i, parent: item[1], role: role };
    if (KEEP[role] === 1) {
      var pos = geometry(val(raw, "AXPosition")) || [0, 0];
      var size = geometry(val(raw, "AXSize")) || [0, 0];
      var enabled = val(raw, "AXEnabled");
      var focused = val(raw, "AXFocused");
      n.subrole = text(val(raw, "AXSubrole"));
      n.label = text(val(raw, "AXDescription"));
      n.title = text(val(raw, "AXTitle"));
      n.help = text(val(raw, "AXHelp"));
      n.url = text(val(raw, "AXURL"));
      n.value = role === "AXButton" ? "" : text(val(raw, "AXValue"));
      n.placeholder = text(val(raw, "AXPlaceholderValue"));
      n.enabled = enabled === undefined ? true : ObjC.unwrap(enabled) !== false;
      n.focused = focused === undefined ? false : ObjC.unwrap(focused) === true;
      n.x = pos[0]; n.y = pos[1]; n.w = size[0]; n.h = size[1];
      n.hasText = false;
      elements[i] = el;
    }
    nodes[i] = n;
    var kids = val(raw, "AXChildren");
    if (kids !== undefined) {
      var count = Number(kids.count);
      for (var k = count - 1; k >= 0; k--) stack.push([kids.objectAtIndex(k), i]);
    }
    if (role === "AXStaticText" && n.parent >= 0 && nodes[n.parent] && nodes[n.parent].role === "AXButton") nodes[n.parent].hasText = true;
  }
  return { nodes: nodes, elements: elements, visited: visited, truncated: stack.length > 0 };
}

/** The claude.ai page: the desktop app's own shell is a file:// web area that holds it. */
function findClaudeArea(root, depth) {
  var queue = [[root, 0]];
  while (queue.length) {
    var item = queue.shift();
    if (roleOf(item[0]) === "AXWebArea" && /^https:\/\/([a-z0-9-]+\.)*claude\.ai\//i.test(text(attr(item[0], "AXURL")))) return item[0];
    if (item[1] >= depth) continue;
    var kids = attr(item[0], "AXChildren");
    if (kids === undefined) continue;
    for (var k = 0; k < Number(kids.count); k++) queue.push([kids.objectAtIndex(k), item[1] + 1]);
  }
  return null;
}

function roleOf(el) {
  return text(attr(el, "AXRole"));
}

function sleepMs(ms) { delay(ms / 1000); }

function now() { return Date.now(); }

function waitFor(fn, ms, step) {
  var end = now() + ms;
  var got = fn();
  while (!got && now() < end) {
    sleepMs(step || 150);
    got = fn();
  }
  return got;
}

/**
 * The window to work in. Claude Code opens windows of its own beside the chat window, so the window
 * on a chat wins over the focused one, and is raised when it is not in front.
 */
function webAreaOf(app) {
  var ws = attr(app, "AXWindows");
  if (ws === undefined || Number(ws.count) === 0) return null;
  var focused = attr(app, "AXFocusedWindow");
  var best = null;
  for (var w = 0; w < Number(ws.count); w++) {
    var win = ws.objectAtIndex(w);
    if (roleOf(win) !== "AXWindow") continue;
    var area = findClaudeArea(win, 20);
    if (!area) continue;
    var kids = attr(area, "AXChildren");
    if (kids === undefined || Number(kids.count) === 0) continue;
    var isFocused = focused !== undefined && $.CFEqual(focused, win);
    var rank = (screenOf(areaUrl(area)) === "chat" ? 2 : 0) + (isFocused ? 1 : 0);
    if (!best || rank > best.rank) best = { win: win, area: area, rank: rank, focused: isFocused };
  }
  if (best && !best.focused) {
    $.AXUIElementPerformAction(best.win, $("AXRaise"));
    $.AXUIElementSetAttributeValue(best.win, $("AXMain"), $.kCFBooleanTrue);
  }
  return best;
}

function areaUrl(area) {
  return text(attr(area, "AXURL"));
}

/** The focused element's surroundings first: a long chat has thousands of elements, the composer a few dozen. */
function snapshotNear(app, area) {
  var f = attr(app, "AXFocusedUIElement");
  if (f === undefined) return null;
  var role = roleOf(f);
  if (role !== "AXTextArea" && role !== "AXTextField") return null;
  var at = f;
  for (var level = 0; level < 7; level++) {
    var p = attr(at, "AXParent");
    if (p === undefined) break;
    at = p;
  }
  var snap = collect(at, 1500);
  snap.url = areaUrl(area);
  return snap;
}

function snapshotAll(area, budget) {
  var snap = collect(area, budget);
  snap.url = areaUrl(area);
  return snap;
}

function look(app, area) {
  var near = snapshotNear(app, area);
  if (near) {
    var d = decide(near);
    if (d.action !== "none") return { snap: near, d: d, scope: "composer" };
  }
  var all = snapshotAll(area, 40000);
  return { snap: all, d: decide(all), scope: "window" };
}

function press(el) {
  return $.AXUIElementPerformAction(el, $("AXPress")) === 0;
}

var openBundle = "";

/**
 * Brings this pid forward. AXFrontmost is ignored for a background caller and macOS may refuse an
 * activation it did not see the user ask for; LaunchServices (\`open -b\`) is let through, so it is
 * used as well whenever it cannot pick another instance (the caller passes the bundle id only then).
 */
function front(pid) {
  var running = $.NSRunningApplication.runningApplicationWithProcessIdentifier(pid);
  if (running && !running.isNil()) running.activateWithOptions(3);
  if (openBundle && frontPid() !== pid) {
    var sa = Application.currentApplication();
    sa.includeStandardAdditions = true;
    try { sa.doShellScript("/usr/bin/open -b " + openBundle); } catch (e) {}
  }
}

function frontPid() {
  var f = $.NSWorkspace.sharedWorkspace.frontmostApplication;
  return f && !f.isNil() ? f.processIdentifier : -1;
}

/** Escape, key code 53, down and up. */
function pressEscape() {
  ObjC.import("CoreGraphics");
  var down = $.CGEventCreateKeyboardEvent(null, 53, true);
  $.CGEventPost(0, down);
  delay(0.05);
  var up = $.CGEventCreateKeyboardEvent(null, 53, false);
  $.CGEventPost(0, up);
}

function run(argv) {
  var pid = parseInt(argv[0], 10);
  var mayDeepLink = argv[1] === "deeplink";
  var waitMs = parseInt(argv[2] || "15000", 10);
  // "dry": find and report, press and navigate nothing (for checking a Mac by hand).
  var dry = argv[3] === "dry";
  openBundle = /^[A-Za-z0-9.-]+$/.test(argv[4] || "") ? argv[4] : "";
  var steps = [];
  var app = $.AXUIElementCreateApplication(pid);
  // Electron builds the page's tree only for a window that exists while Claude is frontmost and the flag
  // is set; a flag set during launch, or on a window in the background, is ignored. So until the page
  // shows, keep Claude in front and set the flag again.
  var web = waitFor(function () {
    if (!dry && frontPid() !== pid) front(pid);
    $.AXUIElementSetAttributeValue(app, $("AXManualAccessibility"), $.kCFBooleanTrue);
    return webAreaOf(app);
  }, waitMs, 300);
  if (!web) return JSON.stringify({ result: "no-window", steps: steps });

  // Ways out when the button is not there, tried in this order: Escape closes what covers the chat
  // (settings, a menu, a dialog: Claude hides everything under a modal), then a new chat replaces a
  // screen that is not a chat or a message box holding a draft.
  var recoveries = ["escape", "new-chat"];
  var attempts = recoveries.length + 1;
  for (var attempt = 0; attempt < attempts; attempt++) {
    var seen = waitFor(function () {
      var w = webAreaOf(app);
      if (!w) return null;
      web = w;
      var l = look(app, w.area);
      // A page that has just loaded shows its controls a moment later: give the button that moment.
      return l.d.action === "none" && (attempt === 0 || l.d.reason === "no-composer") ? null : l;
    }, attempt === 0 ? 2500 : 6000, 300);
    if (!seen) seen = look(app, web.area);
    var d = seen.d;
    steps.push({ attempt: attempt, scope: seen.scope, visited: seen.snap.visited, url: seen.snap.url, decision: d });
    if (d.action === "active") return JSON.stringify({ result: "already-on", steps: steps });
    if (dry) return JSON.stringify({ result: "dry-run", steps: steps });
    if (d.action === "press") {
      var el = seen.snap.elements[d.index];
      front(pid);
      if (!el || !press(el)) return JSON.stringify({ result: "press-failed", steps: steps });
      var on = waitFor(function () {
        var w = webAreaOf(app);
        if (!w) return null;
        var after = look(app, w.area).d;
        return after.action === "active" ? after : null;
      }, 6000, 300);
      return JSON.stringify({ result: on ? "started" : "pressed", label: d.label, why: d.why, steps: steps });
    }
    var recovered = false;
    while (!recovered && recoveries.length) {
      var next = recoveries.shift();
      if (next === "escape" && d.reason === "no-composer") {
        // Keys go to the frontmost app, so only when that is this Claude.
        front(pid);
        sleepMs(200);
        if (frontPid() === pid) {
          pressEscape();
          steps.push({ navigate: "escape" });
          recovered = true;
        }
      } else if (next === "new-chat") {
        if (d.newChat >= 0 && seen.snap.elements[d.newChat] && press(seen.snap.elements[d.newChat])) {
          steps.push({ navigate: "new-chat-button" });
          recovered = true;
        } else if (mayDeepLink) {
          $.NSWorkspace.sharedWorkspace.openURL($.NSURL.URLWithString("claude://claude.ai/new"));
          steps.push({ navigate: "deep-link" });
          recovered = true;
        }
      }
    }
    if (!recovered) break;
    sleepMs(600);
    front(pid);
  }
  return JSON.stringify({ result: "not-found", steps: steps });
}
`;

/** The whole JXA program; `osascript -l JavaScript -e <script> <pid> <deeplink|no> <waitMs> [dry]`. */
export function claudeAxScript(): string {
  return `${DECIDE_SOURCE}\n${COLLECT_SOURCE}`;
}

export interface AxStep {
  attempt?: number;
  scope?: string;
  visited?: number;
  url?: string;
  navigate?: string;
  decision?: { action: string; reason?: string; screen?: string; label?: string; labels?: string[] };
}

export interface AxResult {
  result: "started" | "pressed" | "already-on" | "not-found" | "no-window" | "press-failed" | "dry-run";
  label?: string;
  why?: string;
  steps: AxStep[];
}
