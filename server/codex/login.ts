// Signing in to ChatGPT from the sidebar: a device code the user enters on any device, phone
// included. The login is Codex's own and lands in Codex's store; God Mode only watches it finish.
import { homedir } from "node:os";
import { AppServer } from "./app-server.ts";
import { findCodex } from "./locate.ts";

const CODE_LIFETIME_MS = 15 * 60_000;
const KEEP_RESULT_MS = 10 * 60_000;

interface Session {
  server: AppServer | null;
  state: "pending" | "done" | "failed";
  error: string | null;
  timer: NodeJS.Timeout;
}

export class LoginManager {
  private readonly sessions = new Map<string, Session>();

  async start(): Promise<{ loginId: string; verificationUrl: string; userCode: string }> {
    const codex = await findCodex();
    if (!codex) throw new Error("No Codex CLI found. Install the ChatGPT desktop app or the Codex CLI.");
    const server = await AppServer.start(codex, { cwd: homedir(), timeoutMs: 30_000 });
    try {
      const started = await server.request<{ type: string; loginId: string; verificationUrl: string; userCode: string }>("account/login/start", { type: "chatgptDeviceCode" });
      const session: Session = {
        server,
        state: "pending",
        error: null,
        timer: setTimeout(() => this.finish(started.loginId, "failed", "The code expired. Start again."), CODE_LIFETIME_MS),
      };
      server.on("account/login/completed", (params) => {
        const done = params as { loginId: string | null; success: boolean; error: string | null };
        if (done.loginId === started.loginId) this.finish(started.loginId, done.success ? "done" : "failed", done.error);
      });
      this.sessions.set(started.loginId, session);
      return { loginId: started.loginId, verificationUrl: started.verificationUrl, userCode: started.userCode };
    } catch (error) {
      server.close();
      throw error;
    }
  }

  status(loginId: string): { state: "pending" | "done" | "failed" | "unknown"; error: string | null } {
    const session = this.sessions.get(loginId);
    return session ? { state: session.state, error: session.error } : { state: "unknown", error: null };
  }

  private finish(loginId: string, state: "done" | "failed", error: string | null) {
    const session = this.sessions.get(loginId);
    if (!session || session.state !== "pending") return;
    clearTimeout(session.timer);
    session.state = state;
    session.error = error;
    session.server?.close();
    session.server = null;
    session.timer = setTimeout(() => this.sessions.delete(loginId), KEEP_RESULT_MS);
  }

  close() {
    for (const [loginId] of this.sessions) this.finish(loginId, "failed", "God Mode stopped.");
  }
}
