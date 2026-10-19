// Parses accelerators such as "cmd+shift+v" or "Ctrl+Option+Space" into a macOS
// virtual key code and CGEventFlags for a synthetic key press.

const MODIFIER_FLAGS: Record<string, number> = {
  cmd: 0x100000,
  command: 0x100000,
  shift: 0x20000,
  ctrl: 0x40000,
  control: 0x40000,
  alt: 0x80000,
  opt: 0x80000,
  option: 0x80000,
};

// ANSI layout virtual key codes (HIToolbox Events.h).
const KEY_CODES: Record<string, number> = {
  a: 0, s: 1, d: 2, f: 3, h: 4, g: 5, z: 6, x: 7, c: 8, v: 9, b: 11, q: 12,
  w: 13, e: 14, r: 15, y: 16, t: 17, "1": 18, "2": 19, "3": 20, "4": 21,
  "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27, "8": 28, "0": 29,
  "]": 30, o: 31, u: 32, "[": 33, i: 34, p: 35, return: 36, enter: 36, l: 37,
  j: 38, "'": 39, k: 40, ";": 41, "\\": 42, ",": 43, "/": 44, n: 45, m: 46,
  ".": 47, tab: 48, space: 49, "`": 50, escape: 53, esc: 53,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100,
  f9: 101, f10: 109, f11: 103, f12: 111, f13: 105, f14: 107, f15: 113,
  f16: 106, f17: 64, f18: 79, f19: 80, f20: 90,
};

export interface KeyPress {
  keyCode: number;
  flags: number;
}

export function parseHotkey(input: string): KeyPress | null {
  const parts = input
    .split("+")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  if (parts.length === 0) return null;
  const key = parts[parts.length - 1]!;
  const keyCode = KEY_CODES[key];
  if (keyCode === undefined) return null;
  let flags = 0;
  for (const modifier of parts.slice(0, -1)) {
    const flag = MODIFIER_FLAGS[modifier];
    if (flag === undefined) return null;
    flags |= flag;
  }
  // A bare letter would type into whatever app has focus; require a modifier
  // unless the key is a function key.
  if (flags === 0 && !/^f\d+$/.test(key)) return null;
  return { keyCode, flags };
}
