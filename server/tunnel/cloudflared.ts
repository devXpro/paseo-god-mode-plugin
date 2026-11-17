// God Mode's tunnel: cloudflared publishes the gateway at https://<label>.<domain> through the user's
// own Cloudflare account. The plugin installs cloudflared when it is missing, signs in through a link
// the user opens wherever they pressed the button, creates the tunnel and its DNS record, deletes the
// sign-in key, and keeps cloudflared running for as long as the plugin runs.
import { type ChildProcess, spawn } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { arch, homedir } from "node:os";
import { join } from "node:path";
import { run, tail } from "../process.ts";
import { dataDir, readJson, writeJson } from "../store.ts";

export interface TunnelRecord {
  url: string;
  hostname: string;
  tunnelId: string;
  name: string;
}

export type SetupState =
  | { step: "idle" }
  | { step: "installing" }
  | { step: "signing-in"; loginUrl: string; expiresAt: string }
  | { step: "creating" }
  | { step: "done"; url: string }
  | { step: "failed"; error: string };

export interface TunnelStatus {
  record: TunnelRecord | null;
  running: boolean;
  connected: boolean;
  setup: SetupState;
}

const LOGIN_WAIT_MS = 10 * 60_000;
const WINDOWS = process.platform === "win32";
const BREW = ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"];
const tunnelDir = () => join(dataDir(), "tunnel");
const recordFile = () => join(dataDir(), "tunnel.json");
const configFile = () => join(tunnelDir(), "config.yml");
const credentialsFile = () => join(tunnelDir(), "credentials.json");
const logFile = () => join(tunnelDir(), "cloudflared.log");
const pidFile = () => join(tunnelDir(), "cloudflared.pid");
const originCert = () => join(homedir(), ".cloudflared", "cert.pem");
const ownBinary = () => join(dataDir(), "bin", WINDOWS ? "cloudflared.exe" : "cloudflared");

/** Where cloudflared is: Homebrew's, or the copy God Mode downloaded. */
export function findCloudflared(): string | null {
  return ["/opt/homebrew/bin/cloudflared", "/usr/local/bin/cloudflared", ownBinary()].find((path) => existsSync(path)) ?? null;
}

async function install(): Promise<string> {
  const brew = BREW.find((path) => existsSync(path));
  if (brew) {
    const result = await run(brew, ["install", "cloudflared"], { timeoutMs: 10 * 60_000 });
    if (!result.ok) throw new Error(`brew install cloudflared failed:\n${tail(result)}`);
  } else {
    // Without Homebrew: Cloudflare's own release build, in God Mode's data directory. On Windows it is
    // the .exe itself; there is no arm64 build, and the amd64 one runs under emulation.
    const asset = WINDOWS ? "cloudflared-windows-amd64.exe" : `cloudflared-darwin-${arch() === "arm64" ? "arm64" : "amd64"}.tgz`;
    const response = await fetch(`https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}`);
    if (!response.ok) throw new Error(`Downloading ${asset} failed: HTTP ${response.status}`);
    const dir = join(dataDir(), "bin");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const body = Buffer.from(await response.arrayBuffer());
    if (WINDOWS) {
      await writeFile(ownBinary(), body);
    } else {
      const archive = join(dir, asset);
      await writeFile(archive, body, { mode: 0o600 });
      const unpacked = await run("/usr/bin/tar", ["-xzf", archive, "-C", dir]);
      await rm(archive, { force: true });
      if (!unpacked.ok) throw new Error(`Unpacking ${asset} failed:\n${tail(unpacked)}`);
      await chmod(ownBinary(), 0o755);
    }
  }
  const found = findCloudflared();
  if (!found) throw new Error("cloudflared was installed but is not where God Mode looks for it.");
  return found;
}

/** The hostname a `tunnel route dns` answer names, or null. */
export function routedHostname(output: string): string | null {
  return (
    /Added CNAME ([a-z0-9.-]+\.[a-z]{2,})/i.exec(output)?.[1] ??
    /([a-z0-9.-]+\.[a-z]{2,}) is already configured to route to your tunnel/i.exec(output)?.[1] ??
    null
  )?.toLowerCase() ?? null;
}

export function configText(tunnelId: string, hostname: string, port: number): string {
  return [
    "# God Mode's tunnel: this hostname to the gateway on this Mac. Nothing else is published.",
    `tunnel: ${tunnelId}`,
    `credentials-file: ${credentialsFile()}`,
    "no-autoupdate: true",
    "ingress:",
    `  - hostname: ${hostname}`,
    `    service: http://127.0.0.1:${port}`,
    "  - service: http_status:404",
    "",
  ].join("\n");
}

export class Tunnel {
  private record: TunnelRecord | null = null;
  private setupState: SetupState = { step: "idle" };
  private login: ChildProcess | null = null;
  private child: ChildProcess | null = null;
  private connected = false;
  private stopping = false;
  private restarts = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  private readonly port: number;
  private readonly onUrl: (url: string | null) => void;

  constructor(port: number, onUrl: (url: string | null) => void) {
    this.port = port;
    this.onUrl = onUrl;
  }

  /** Picks up an existing tunnel and runs it. */
  async start(): Promise<void> {
    this.record = await readJson<TunnelRecord | null>(recordFile(), null);
    if (this.record && existsSync(configFile()) && existsSync(credentialsFile())) {
      this.onUrl(this.record.url);
      await this.run();
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.login?.kill();
    this.child?.kill();
  }

  status(): TunnelStatus {
    return { record: this.record, running: Boolean(this.child), connected: this.connected, setup: this.setupState };
  }

  /**
   * The one-button setup: install cloudflared if needed, then a sign-in link for the user to open.
   * Returns once the link is known; creating the tunnel follows when Cloudflare hands over the key.
   */
  async beginSetup(label = "gm"): Promise<SetupState> {
    if (this.setupState.step === "installing" || this.setupState.step === "signing-in" || this.setupState.step === "creating") return this.setupState;
    try {
      this.setupState = { step: "installing" };
      const binary = findCloudflared() ?? (await install());
      await rm(originCert(), { force: true });
      const { loginUrl, done } = await this.signIn(binary);
      this.setupState = { step: "signing-in", loginUrl, expiresAt: new Date(Date.now() + LOGIN_WAIT_MS).toISOString() };
      void done
        .then(() => this.create(binary, label))
        .catch((error) => {
          this.setupState = { step: "failed", error: String(error?.message ?? error) };
        });
    } catch (error) {
      this.setupState = { step: "failed", error: String((error as Error)?.message ?? error) };
    }
    return this.setupState;
  }

  /** Starts `cloudflared tunnel login` without a browser on this Mac; resolves its link, then the key. */
  private signIn(binary: string): Promise<{ loginUrl: string; done: Promise<void> }> {
    return new Promise((resolveLink, rejectLink) => {
      // A PATH without /usr/bin keeps cloudflared from opening a browser here: the link goes to the
      // device the user pressed the button on. Windows ignores the case of variable names: Node keeps
      // this PATH and drops the inherited Path, so cloudflared does not find cmd to open one either.
      const login = spawn(binary, ["tunnel", "login"], { env: { ...process.env, PATH: "/opt/homebrew/bin" }, stdio: ["ignore", "pipe", "pipe"] });
      this.login = login;
      let output = "";
      let linked = false;
      let finish: (error?: Error) => void = () => {};
      const done = new Promise<void>((resolve, reject) => {
        finish = (error) => (error ? reject(error) : resolve());
      });
      const watch = setInterval(() => {
        if (existsSync(originCert())) {
          clearInterval(watch);
          login.kill();
          finish();
        }
      }, 1000);
      const read = (chunk: Buffer) => {
        output += chunk;
        const link = /https:\/\/dash\.cloudflare\.com\/argotunnel\S+/.exec(output)?.[0];
        if (link && !linked) {
          linked = true;
          resolveLink({ loginUrl: link, done });
        }
      };
      login.stdout?.on("data", read);
      login.stderr?.on("data", read);
      login.on("exit", () => {
        this.login = null;
        setTimeout(() => {
          clearInterval(watch);
          if (existsSync(originCert())) return finish();
          const error = new Error(/Failed to fetch resource/.test(output) ? "The sign-in link expired. Press the button again." : "Signing in to Cloudflare did not finish.");
          if (linked) finish(error);
          else rejectLink(error);
        }, 1500);
      });
    });
  }

  private async create(binary: string, label: string): Promise<void> {
    this.setupState = { step: "creating" };
    await mkdir(tunnelDir(), { recursive: true, mode: 0o700 });
    try {
      let name = "god-mode";
      let created = await run(binary, ["tunnel", "create", "--credentials-file", credentialsFile(), name], { timeoutMs: 60_000 });
      if (!created.ok && /already exists/i.test(`${created.stdout}${created.stderr}`)) {
        name = `god-mode-${Math.random().toString(36).slice(2, 6)}`;
        created = await run(binary, ["tunnel", "create", "--credentials-file", credentialsFile(), name], { timeoutMs: 60_000 });
      }
      if (!created.ok) throw new Error(`Creating the tunnel failed:\n${tail(created)}`);
      const tunnelId = (JSON.parse(await readFile(credentialsFile(), "utf8")) as { TunnelID: string }).TunnelID;
      // A bare label is created in the domain the user picked while signing in.
      const routed = await run(binary, ["tunnel", "route", "dns", "--overwrite-dns", tunnelId, label], { timeoutMs: 60_000 });
      const hostname = routedHostname(`${routed.stdout}\n${routed.stderr}`);
      if (!routed.ok || !hostname) throw new Error(`Creating the address failed:\n${tail(routed)}`);
      await writeFile(configFile(), configText(tunnelId, hostname, this.port), { mode: 0o600 });
      const record: TunnelRecord = { url: `https://${hostname}`, hostname, tunnelId, name };
      await writeJson(recordFile(), record);
      this.record = record;
      this.setupState = { step: "done", url: record.url };
      this.onUrl(record.url);
      await this.run();
    } finally {
      // The sign-in key can create and delete tunnels and DNS records: it never stays on this Mac.
      await rm(originCert(), { force: true });
    }
  }

  /** Runs cloudflared and restarts it, a little later each time, whenever it stops. */
  private async run(): Promise<void> {
    const binary = findCloudflared();
    if (!binary || this.stopping) return;
    await this.stopStray();
    await mkdir(tunnelDir(), { recursive: true, mode: 0o700 });
    const log = createWriteStream(logFile(), { flags: "a", mode: 0o600 });
    const child = spawn(binary, ["tunnel", "--config", configFile(), "run"], { stdio: ["ignore", "pipe", "pipe"] });
    this.child = child;
    this.connected = false;
    await writeFile(pidFile(), `${child.pid}\n`, { mode: 0o600 });
    const read = (chunk: Buffer) => {
      log.write(chunk);
      if (/Registered tunnel connection/.test(String(chunk))) {
        this.connected = true;
        this.restarts = 0;
      }
    };
    child.stdout?.on("data", read);
    child.stderr?.on("data", read);
    child.on("exit", () => {
      log.end();
      this.child = null;
      this.connected = false;
      if (this.stopping) return;
      const delay = Math.min(60_000, 1000 * 2 ** this.restarts);
      this.restarts += 1;
      this.restartTimer = setTimeout(() => void this.run(), delay);
    });
  }

  /** A cloudflared for this tunnel left from an earlier run (or started by hand) is stopped first. */
  private async stopStray(): Promise<void> {
    const pid = Number((await readFile(pidFile(), "utf8").catch(() => "")).trim());
    if (!pid) return;
    const command = await run("/bin/ps", ["-o", "command=", "-p", String(pid)]);
    if (command.ok && command.stdout.includes("cloudflared") && command.stdout.includes(configFile())) {
      try {
        process.kill(pid);
      } catch {
        // Already gone.
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}
