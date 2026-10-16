import { access, constants } from "node:fs/promises";
import { delimiter, join } from "node:path";

// The ChatGPT desktop app ships a Codex CLI that is already signed in; a standalone one is on PATH.
const BUNDLED_CODEX = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex";

export async function findExecutable(name: string, preferred: string[] = [], path = process.env.PATH ?? ""): Promise<string | null> {
  const candidates = [...preferred, ...path.split(delimiter).filter(Boolean).map((dir) => join(dir, name))];
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not here, try the next one
    }
  }
  return null;
}

export const findCodex = () => findExecutable("codex", [BUNDLED_CODEX]);
