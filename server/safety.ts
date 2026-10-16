// Guards for everything God Mode prints, logs or returns to a client.

// sites.get_site returns a bearer that bypasses the Site's sign-in and other tools return short-lived
// git credentials. Anything under a key like these is replaced before it can reach a log or a screen.
const SECRET_KEY = /token|credential|secret|password|bearer|authorization|cookie/i;

export function redact<T>(value: T): T {
  if (Array.isArray(value)) return value.map(redact) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, v]) => [key, SECRET_KEY.test(key) ? "[redacted]" : redact(v)]),
    ) as T;
  }
  return value;
}

/** Free text from tools and child processes: bearer tokens, pairing offers and token-like JSON fields. */
export function scrubText(text: string): string {
  return text
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[redacted]")
    .replace(/#offer=[A-Za-z0-9._~%+/=-]+/g, "#offer=[redacted]")
    .replace(/("?[A-Za-z_]*(?:token|secret|password|credential)[A-Za-z_]*"?\s*[:=]\s*)"[^"]*"/gi, '$1"[redacted]"');
}

type Schema = {
  type?: string | string[];
  enum?: unknown[];
  required?: string[];
  properties?: Record<string, Schema>;
  items?: Schema;
} | undefined;

/** Enough JSON Schema to check a tool's structuredContent against its outputSchema: type (and type
 *  arrays), required, properties, items, enum. */
export function validate(schema: Schema, value: unknown, path = "$"): string[] {
  const typeOf = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v);
  const types = ([] as string[]).concat(schema?.type ?? []);
  if (types.length && !types.some((t) => t === typeOf(value) || (t === "number" && typeof value === "number"))) {
    return [`${path}: expected ${types.join("|")}, got ${typeOf(value)}`];
  }
  const errors: string[] = [];
  if (schema?.enum && !schema.enum.includes(value)) errors.push(`${path}: ${JSON.stringify(value)} not in enum`);
  if (typeOf(value) === "object") {
    const object = value as Record<string, unknown>;
    for (const key of schema?.required ?? []) if (!(key in object)) errors.push(`${path}.${key}: missing`);
    for (const [key, sub] of Object.entries(schema?.properties ?? {})) {
      if (object[key] !== undefined) errors.push(...validate(sub, object[key], `${path}.${key}`));
    }
  }
  if (typeOf(value) === "array" && schema?.items) {
    (value as unknown[]).forEach((v, i) => errors.push(...validate(schema.items, v, `${path}[${i}]`)));
  }
  return errors;
}
