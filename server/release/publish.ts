// The one model-driven step. A direct app-server call cannot carry the archive: the Sites connector
// wants an uploaded file there, and only Codex's own tool layer uploads a local path. So Codex makes
// exactly one tool call with arguments God Mode prepared; everything around it is checked without it.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, tail } from "../process.ts";

const RESULT_SCHEMA = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["deployed", "failed"] },
    version_number: { type: ["integer", "null"] },
    deployment_id: { type: ["string", "null"] },
    message: { type: "string" },
  },
  required: ["status", "version_number", "deployment_id", "message"],
  additionalProperties: false,
};

export interface PublishInput {
  projectId: string;
  commitSha: string;
  archive: string;
}

export function publishPrompt({ projectId, commitSha, archive }: PublishInput): string {
  return [
    "You are one step of an automated release. Make exactly one tool call and nothing else.",
    `Call the Sites tool save_version_and_deploy_private with project_id "${projectId}", commit_sha "${commitSha}" and archive "${archive}".`,
    "The commit is already pushed and the archive is already built from it.",
    "Do not run commands, read or edit files, push, build, or call any other tool, even if the call fails.",
    "Then return only the JSON result: status is deployed when the call returned a deployment, otherwise failed; message is one sentence.",
  ].join("\n");
}

export interface PublishReport {
  status: "deployed" | "failed";
  version_number: number | null;
  deployment_id: string | null;
  message: string;
}

export async function publishWithCodex(codex: string, checkoutDir: string, input: PublishInput, log: (line: string) => void): Promise<PublishReport> {
  const work = await mkdtemp(join(tmpdir(), "god-mode-publish-"));
  try {
    const schemaFile = join(work, "schema.json");
    const resultFile = join(work, "result.json");
    await writeFile(schemaFile, JSON.stringify(RESULT_SCHEMA));
    log("codex exec: save_version_and_deploy_private");
    const result = await run(
      codex,
      ["exec", "--ephemeral", "--approve-for-me", "--output-schema", schemaFile, "-o", resultFile, publishPrompt(input)],
      { cwd: checkoutDir, timeoutMs: 15 * 60_000 },
    );
    if (!result.ok) throw new Error(`codex exec failed (${result.code}):\n${tail(result)}`);
    try {
      return JSON.parse(await readFile(resultFile, "utf8")) as PublishReport;
    } catch {
      throw new Error(`codex exec returned no result:\n${tail(result)}`);
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
