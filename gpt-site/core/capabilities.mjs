// Plugins that describe themselves to God Mode. Paseo gives a remote client plugin ids and a blind
// invokePluginRpc, nothing about what a method reads or changes, so a plugin that wants to be
// usable from ChatGPT answers the RPC `meta.describe` with the paseo.capabilities/1 shape (see
// docs/plugin-capabilities.md). This module checks those answers and turns tool arguments into
// one exact RPC call. No plugin is known here by name, and no I/O happens here: core/paseo.mjs
// makes the relay calls, core/capabilities.test.mjs covers the rest.
import { resolve, truncate } from "./text.mjs";

export const DESCRIBE_METHOD = "meta.describe";
export const CAPABILITIES_SCHEMA = "paseo.capabilities/1";

const RISKS = ["low", "outward", "disruptive", "destructive"];
const OPERATION_ID = /^[a-z][a-z0-9_]*$/;
// The SDK's own rule for RPC names.
const RPC_NAME = /^[a-z][a-z0-9._-]*$/;
const MAX_OPERATIONS = 40;
// Field names whose values never reach ChatGPT, whatever a plugin returns.
const SECRET_KEY = /token|secret|password|passwd|credential|cookie|bearer|authorization|api.?key|private.?key/i;

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value, max) => (typeof value === "string" ? value.trim().slice(0, max) : "");

// ---- The description ------------------------------------------------------------------------

// One operation, or the reason it cannot be offered. Actions without a known risk count as
// destructive, and only a low-risk action may skip the confirmation.
function parseOperation(raw) {
  if (!isObject(raw)) return { skip: "not an object" };
  const id = text(raw.id, 64);
  if (!OPERATION_ID.test(id)) return { skip: "id must be lower case letters, digits and _" };
  if (raw.kind !== "read" && raw.kind !== "action") return { skip: 'kind must be "read" or "action"' };
  const method = text(raw.method, 120);
  if (!RPC_NAME.test(method)) return { skip: "method is not an RPC name" };
  if (method.startsWith("meta.")) return { skip: "meta.* methods describe the plugin and are never operations" };
  const title = text(raw.title, 80);
  if (!title) return { skip: "title is missing" };
  const input = raw.input === undefined ? { type: "object", properties: {} } : raw.input;
  if (!isObject(input) || input.type !== "object") return { skip: "input must be a JSON Schema of type object" };
  if (raw.fixed !== undefined && !isObject(raw.fixed)) return { skip: "fixed must be an object" };
  const fixed = raw.fixed ?? {};
  const offered = Object.keys(isObject(input.properties) ? input.properties : {});
  const overlap = Object.keys(fixed).find((key) => offered.includes(key));
  if (overlap) return { skip: `fixed argument "${overlap}" is also offered to the caller` };
  // The fields of the answer worth reading out, for reads and for actions that answer with a state.
  const fields = Array.isArray(raw.output?.fields) ? raw.output.fields.filter((f) => typeof f === "string") : null;
  const op = { id, kind: raw.kind, method, title, description: text(raw.description, 600), input, fixed, fields };
  if (raw.kind === "read") return { op: { ...op, default: raw.default === true } };
  const risk = RISKS.includes(raw.risk) ? raw.risk : "destructive";
  const confirm = risk === "low" && raw.confirm !== "always" ? "none" : "always";
  return { op: { ...op, risk, confirm, confirmText: text(raw.confirmText, 600) } };
}

// A plugin's meta.describe answer → { capabilities } or { invalid: reason }. Broken operations are
// dropped one by one, with their reasons kept for the catalog, so one bad entry costs only itself.
export function parseCapabilities(raw) {
  if (!isObject(raw) || raw.schema !== CAPABILITIES_SCHEMA) return { invalid: `not ${CAPABILITIES_SCHEMA}` };
  const title = text(raw.title, 80);
  if (!title) return { invalid: "title is missing" };
  if (!Array.isArray(raw.operations)) return { invalid: "operations is missing" };
  const operations = [];
  const skipped = [];
  let hasDefault = false;
  for (const entry of raw.operations.slice(0, MAX_OPERATIONS)) {
    const { op, skip } = parseOperation(entry);
    const id = typeof entry?.id === "string" ? entry.id : "?";
    if (skip) skipped.push({ id, reason: skip });
    else if (operations.some((o) => o.id === op.id)) skipped.push({ id, reason: "duplicate id" });
    else {
      // The first default read wins; a second one is only a read.
      if (op.default) op.default = !hasDefault;
      hasDefault ||= op.default === true;
      operations.push(op);
    }
  }
  if (operations.length === 0) return { invalid: "no usable operations" };
  const aliases = Array.isArray(raw.aliases) ? raw.aliases.filter((a) => typeof a === "string").slice(0, 20).map((a) => a.slice(0, 60)) : [];
  return { capabilities: { title, summary: text(raw.summary, 300), aliases, operations, skipped } };
}

// ---- Finding what the user meant ------------------------------------------------------------

// Plugins are matched on their id, title and aliases, the way chats are matched on their names.
export function pickPlugin(entries, query) {
  const raw = String(query ?? "").trim().toLowerCase();
  const exact = entries.find(
    (e) => e.id.toLowerCase() === raw || e.capabilities?.title.toLowerCase() === raw || e.capabilities?.aliases.some((a) => a.toLowerCase() === raw),
  );
  if (exact) return { match: exact };
  return resolve(entries, query, { id: (e) => e.id, text: (e) => [e.id, e.name, e.capabilities?.title, ...(e.capabilities?.aliases ?? [])].filter(Boolean).join(" ") });
}

// An operation of the given kind. No query on a read means the plugin's default read.
export function pickOperation(capabilities, query, kind) {
  const ofKind = capabilities.operations.filter((op) => op.kind === kind);
  if (!query) {
    const fallback = kind === "read" ? ofKind.find((op) => op.default) : null;
    return fallback ? { match: fallback } : { candidates: ofKind };
  }
  const raw = String(query).trim().toLowerCase().replaceAll(" ", "_");
  const exact = capabilities.operations.find((op) => op.id === raw);
  if (exact) return exact.kind === kind ? { match: exact } : { wrongKind: exact };
  const found = resolve(ofKind, query, { id: (op) => op.id, text: (op) => `${op.id.replaceAll("_", " ")} ${op.title}` });
  return found.match ? found : { candidates: found.candidates.length ? found.candidates : ofKind };
}

// ---- Arguments ------------------------------------------------------------------------------

function typeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function sameJson(a, b) {
  return canonical(a) === canonical(b);
}

// Enough JSON Schema to check what ChatGPT sends against what a plugin advertises: type, const,
// enum, anyOf/oneOf, numeric and length bounds, properties, required, additionalProperties,
// items. The plugin's own zod contract checks again; this is for a useful answer before the call.
export function checkValue(schema, value, path = "args") {
  if (!isObject(schema)) return [];
  const errors = [];
  const types = [].concat(schema.type ?? []);
  const actual = typeOf(value);
  if (types.length && !types.some((t) => t === actual || (t === "integer" && Number.isInteger(value)) || (t === "number" && actual === "number"))) {
    return [`${path} must be ${types.join(" or ")}`];
  }
  if ("const" in schema && !sameJson(schema.const, value)) errors.push(`${path} must be ${JSON.stringify(schema.const)}`);
  if (Array.isArray(schema.enum) && !schema.enum.some((option) => sameJson(option, value))) {
    errors.push(`${path} must be one of ${schema.enum.map((o) => JSON.stringify(o)).join(", ")}`);
  }
  const alternatives = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(alternatives) && !alternatives.some((option) => checkValue(option, value, path).length === 0)) {
    errors.push(`${path} must be ${describeSchema(schema)}`);
  }
  if (actual === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) errors.push(`${path} must be at least ${schema.minimum}`);
    if (typeof schema.maximum === "number" && value > schema.maximum) errors.push(`${path} must be at most ${schema.maximum}`);
  }
  if (actual === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) errors.push(`${path} must have at least ${schema.minLength} characters`);
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) errors.push(`${path} must have at most ${schema.maxLength} characters`);
  }
  if (actual === "object") {
    const properties = isObject(schema.properties) ? schema.properties : {};
    for (const key of Array.isArray(schema.required) ? schema.required : []) {
      if (value[key] === undefined) errors.push(`${path}.${key} is required`);
    }
    for (const [key, item] of Object.entries(value)) {
      if (properties[key]) errors.push(...checkValue(properties[key], item, `${path}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${path}.${key} is not an argument`);
    }
  }
  if (actual === "array" && isObject(schema.items)) value.forEach((item, i) => errors.push(...checkValue(schema.items, item, `${path}[${i}]`)));
  return errors;
}

// "30 | 60 | 120", "boolean", "string": what a value may be, for the model and for errors.
function describeSchema(schema) {
  if (!isObject(schema)) return "anything";
  if ("const" in schema) return JSON.stringify(schema.const);
  if (Array.isArray(schema.enum)) return schema.enum.map((o) => JSON.stringify(o)).join(" | ");
  const alternatives = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(alternatives)) return alternatives.map(describeSchema).join(" | ");
  return [].concat(schema.type ?? "any").join(" or ");
}

// The arguments an operation takes, as one line: "minutes: 30 | 60 (required)".
export function signature(op) {
  const properties = isObject(op.input.properties) ? op.input.properties : {};
  const required = Array.isArray(op.input.required) ? op.input.required : [];
  const parts = Object.entries(properties).map(([name, schema]) => {
    const about = typeof schema?.description === "string" && schema.description ? ` – ${truncate(schema.description, 80)}` : "";
    return `${name}: ${describeSchema(schema)}${required.includes(name) ? " (required)" : ""}${about}`;
  });
  return parts.length ? parts.join("; ") : "no arguments";
}

// What ChatGPT sent → the exact RPC input, or { invalid } with what the operation takes. Fixed
// arguments are the plugin's: repeating one is harmless, changing one is refused.
export function prepareArgs(op, args) {
  if (args !== undefined && args !== null && !isObject(args)) return { invalid: `args must be an object; ${op.id} takes ${signature(op)}.` };
  const given = { ...(args ?? {}) };
  for (const [key, value] of Object.entries(op.fixed)) {
    if (!(key in given)) continue;
    if (!sameJson(given[key], value)) return { invalid: `${key} is fixed to ${JSON.stringify(value)} for ${op.id}; ${op.id} takes ${signature(op)}.` };
    delete given[key];
  }
  const properties = isObject(op.input.properties) ? op.input.properties : {};
  const open = op.input.additionalProperties === true || isObject(op.input.additionalProperties);
  const unknown = Object.keys(given).filter((key) => !properties[key] && !open);
  if (unknown.length) return { invalid: `${unknown.join(", ")}: not an argument of ${op.id}; it takes ${signature(op)}.` };
  const errors = checkValue(op.input, given);
  if (errors.length) return { invalid: `${errors.slice(0, 3).join("; ")}. ${op.id} takes ${signature(op)}.` };
  return { args: { ...given, ...op.fixed } };
}

// ---- Results --------------------------------------------------------------------------------

function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, SECRET_KEY.test(key) && typeof v !== "boolean" ? "[redacted]" : redact(v)]));
}

// The answer as structuredContent: the fields the plugin marked worth reading, secrets out, and
// always an object (a list or a bare value is wrapped), since the tools' schemas say object.
export function projectResult(op, output) {
  let value = output;
  if (isObject(value) && op.fields?.length) value = Object.fromEntries(op.fields.filter((f) => f in value).map((f) => [f, value[f]]));
  value = redact(value);
  return isObject(value) ? value : { value: value ?? null };
}

// "key: value" lines for speech, leaving out empty strings and nulls; nested values stay JSON.
export function resultLines(value, max = 1500) {
  const lines = Object.entries(value)
    .filter(([, v]) => v !== "" && v !== null && v !== undefined)
    .map(([key, v]) => `${key}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`);
  return truncate(lines.join("\n") || "(empty)", max);
}

export function actionSummary(op) {
  const args = signature(op);
  return { id: op.id, title: op.title, args, asks_first: op.confirm === "always" };
}

export function actionsLine(capabilities) {
  const actions = capabilities.operations.filter((op) => op.kind === "action");
  if (!actions.length) return "";
  return `Actions (plugin_action): ${actions.map((op) => `${op.id}${op.confirm === "always" ? " [asks first]" : ""}${signature(op) === "no arguments" ? "" : ` (${signature(op)})`}`).join("; ")}.`;
}

// ---- Confirmation -----------------------------------------------------------------------------
// An action that asks first runs only with a token God Mode issued for exactly these arguments a
// moment ago. HMAC-SHA256 over the plugin, operation, method and canonical arguments, keyed from
// the pairing link (the Site's one secret), for two minutes. The token proves what was put to the
// user; that they said yes is ChatGPT's part of the bargain. It is not spent on use: a run is
// reported as done, and the rules say a done action is never repeated.

export const CONFIRMATION_TTL_MS = 120_000;
const encoder = new TextEncoder();

// JSON with sorted keys, so the same arguments always sign the same.
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function base64url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function macOf(secret, expires, subject) {
  const keyBytes = await crypto.subtle.digest("SHA-256", encoder.encode(`god-mode/plugin-confirmation/v1\n${secret}`));
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signed = await crypto.subtle.sign("HMAC", key, encoder.encode(`${expires}\n${canonical(subject)}`));
  return base64url(new Uint8Array(signed));
}

export async function issueConfirmation(secret, subject, now = Date.now()) {
  const expires = now + CONFIRMATION_TTL_MS;
  return { token: `${expires.toString(36)}.${await macOf(secret, expires, subject)}`, expiresAt: new Date(expires).toISOString() };
}

// "ok", "expired", or "mismatch" (forged, garbled, or issued for other arguments).
export async function checkConfirmation(secret, token, subject, now = Date.now()) {
  const [stamp, mac] = String(token ?? "").split(".");
  const expires = parseInt(stamp, 36);
  if (!mac || !Number.isSafeInteger(expires)) return "mismatch";
  const expected = await macOf(secret, expires, subject);
  let diff = expected.length ^ mac.length;
  for (let i = 0; i < expected.length; i += 1) diff |= expected.charCodeAt(i) ^ (mac.charCodeAt(i) || 0);
  if (diff !== 0) return "mismatch";
  return now > expires ? "expired" : "ok";
}
