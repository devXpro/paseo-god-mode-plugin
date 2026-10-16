// A minimal client for `codex app-server`, JSON-RPC over stdio. It reads the ChatGPT login and calls
// ChatGPT app tools such as Sites directly, with no model turn, using this Mac's own Codex login.
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import readline from "node:readline";
import { VERSION } from "../../shared/version.ts";

type Pending = { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout };
type Listener = (params: unknown) => void;

export interface ToolResult {
  isError: boolean;
  text: string;
  structured: Record<string, unknown> | null;
}

export interface AppServerOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export class AppServer {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly timeoutMs: number;
  private readonly cwd: string;
  private nextId = 1;
  private threadId: string | null = null;
  private failure: Error | null = null;
  // process.exit skips finally blocks; never leave an app-server behind.
  private readonly killOnExit = () => this.child.kill();

  static async start(bin: string, options: AppServerOptions = {}): Promise<AppServer> {
    const server = new AppServer(bin, options);
    try {
      await server.request("initialize", { clientInfo: { name: "paseo-god-mode", version: VERSION } });
      server.notify("initialized");
      return server;
    } catch (error) {
      server.close();
      throw error;
    }
  }

  private constructor(bin: string, options: AppServerOptions) {
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.cwd = options.cwd ?? process.cwd();
    this.child = spawn(bin, ["app-server"], { cwd: this.cwd, env: options.env ?? process.env, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stderr.on("data", () => {});
    this.child.on("error", (error) => this.fail(new Error(`codex app-server could not start: ${error.message}`)));
    this.child.on("exit", () => this.fail(new Error("codex app-server exited")));
    process.once("exit", this.killOnExit);
    readline.createInterface({ input: this.child.stdout }).on("line", (line) => this.receive(line));
  }

  private receive(line: string) {
    let message: { id?: number; method?: string; params?: unknown; result?: unknown; error?: { message?: string; code?: number } };
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    // Requests and notifications from the server carry a method; only responses resolve our calls.
    if (message.method) {
      for (const listener of this.listeners.get(message.method) ?? []) listener(message.params);
      return;
    }
    const waiter = message.id === undefined ? undefined : this.pending.get(message.id);
    if (!waiter) return;
    this.pending.delete(message.id as number);
    clearTimeout(waiter.timer);
    if (message.error) waiter.reject(new Error(`${message.error.message ?? "app-server error"} (${message.error.code ?? "?"})`));
    else waiter.resolve(message.result);
  }

  private fail(error: Error) {
    this.failure ??= error;
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.pending.clear();
  }

  private write(message: object) {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  notify(method: string, params?: unknown) {
    this.write({ method, ...(params === undefined ? {} : { params }) });
  }

  request<T = unknown>(method: string, params: unknown = {}, timeoutMs = this.timeoutMs): Promise<T> {
    if (this.failure) return Promise.reject(this.failure);
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${Math.round(timeoutMs / 1000)} s`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      this.write({ id, method, params });
    });
  }

  /** Subscribes to a server notification such as "account/login/completed". */
  on(method: string, listener: Listener): () => void {
    const set = this.listeners.get(method) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(method, set);
    return () => set.delete(listener);
  }

  /** Calls a ChatGPT app tool, e.g. "sites.list_site_versions" or "<site_plugin>.overview". */
  async callTool(tool: string, args: Record<string, unknown> = {}, timeoutMs?: number): Promise<ToolResult> {
    if (!this.threadId) {
      const started = await this.request<{ thread: { id: string } }>("thread/start", { cwd: this.cwd, ephemeral: true });
      this.threadId = started.thread.id;
    }
    const result = await this.request<{ isError?: boolean; content?: { type: string; text?: string }[]; structuredContent?: Record<string, unknown> }>(
      "mcpServer/tool/call",
      { threadId: this.threadId, server: "codex_apps", tool, arguments: args },
      timeoutMs,
    );
    return {
      isError: Boolean(result?.isError),
      text: (result?.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n"),
      structured: result?.structuredContent ?? null,
    };
  }

  /** The ChatGPT app tools this login can call right now, keyed by name ("sites.get_site_version"). */
  async listTools(): Promise<Record<string, { description?: string; inputSchema?: unknown; outputSchema?: unknown }>> {
    const status = await this.request<{ data?: { name: string; tools?: Record<string, { description?: string }> }[] }>("mcpServerStatus/list", {});
    return status?.data?.find((server) => server.name === "codex_apps")?.tools ?? {};
  }

  close() {
    process.removeListener("exit", this.killOnExit);
    this.child.kill();
  }
}
