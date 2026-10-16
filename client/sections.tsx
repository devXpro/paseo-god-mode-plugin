// The steps of the God Mode screen. Each one reads its own state, so the screen walks the user from
// a bare Mac to a live Site and stays the place to update or roll back afterwards.
import type { PluginTheme } from "@getpaseo/plugin";
import { openExternalUrl, useRpc } from "@getpaseo/plugin/client";
import { copyText, useToast } from "@getpaseo/plugin/client/react-native";
import { ExternalLink, SettingsAction, SettingsCard, SettingsInput, SettingsRow, SettingsSection, SettingsSelect, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import {
  type Check,
  type JobView,
  type Preferences,
  checkSlugRpc,
  connectSiteRpc,
  createSiteRpc,
  environmentRpc,
  getPreferencesRpc,
  listSitesRpc,
  loginStartRpc,
  loginStatusRpc,
  releaseStartRpc,
  releaseStatusRpc,
  setPreferencesRpc,
} from "../shared/contracts.ts";

const LABELS: Record<Check["id"], string> = {
  paseo: "Paseo relay",
  codex: "Codex CLI",
  chatgpt: "ChatGPT account",
  node: "Node.js",
  git: "Git",
};

export const ENVIRONMENT_KEY = ["god-mode", "environment"];
export const STATUS_KEY = ["god-mode", "status"];

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

function Note({ theme, text, tone = "muted" }: { theme: PluginTheme; text: string; tone?: "muted" | "bad" | "good" }) {
  const color = tone === "bad" ? theme.colors.statusDanger : tone === "good" ? theme.colors.statusSuccess : theme.colors.foregroundMuted;
  return <Text style={{ color, fontSize: 13, lineHeight: 18, paddingHorizontal: 4 }}>{text}</Text>;
}

function Spinner({ theme }: { theme: PluginTheme }) {
  return (
    <View style={{ padding: 16, alignItems: "center" }}>
      <ActivityIndicator color={theme.colors.accent} />
    </View>
  );
}

/** A button that asks for a second tap before doing something that changes production. */
function ConfirmAction({ label, hint, actionLabel, disabled, onConfirm }: { label: string; hint?: string; actionLabel: string; disabled?: boolean; onConfirm(): void }) {
  const [armed, setArmed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  return (
    <SettingsAction
      label={label}
      hint={armed ? "Tap again to confirm." : hint}
      actionLabel={armed ? "Confirm" : actionLabel}
      disabled={disabled}
      onPress={() => {
        if (armed) {
          setArmed(false);
          onConfirm();
          return;
        }
        setArmed(true);
        timer.current = setTimeout(() => setArmed(false), 6000);
      }}
    />
  );
}

export function MacStep({ theme }: { theme: PluginTheme }) {
  const environment = useRpc(environmentRpc);
  const query = useQuery({ queryKey: ENVIRONMENT_KEY, queryFn: () => environment({}) });
  const chatgpt = query.data?.checks.find((c) => c.id === "chatgpt");
  const codexReady = query.data?.checks.find((c) => c.id === "codex")?.ok;
  return (
    <SettingsSection title="1 · This Mac">
      <SettingsCard>
        {query.isPending ? (
          <Spinner theme={theme} />
        ) : query.isError ? (
          <SettingsRow label="Checks did not run" error={errorText(query.error)} />
        ) : (
          query.data.checks.map((check) => (
            <SettingsRow key={check.id} label={LABELS[check.id]} hint={check.ok ? check.detail : undefined} error={check.ok ? undefined : check.detail}>
              <Text style={{ color: check.ok ? theme.colors.statusSuccess : theme.colors.statusDanger, fontWeight: "600" }}>{check.ok ? "Ready" : "Needs you"}</Text>
            </SettingsRow>
          ))
        )}
        <SettingsAction label="Check again" actionLabel={query.isFetching ? "Checking…" : "Run"} disabled={query.isFetching} onPress={() => void query.refetch()} />
      </SettingsCard>
      {codexReady && chatgpt && !chatgpt.ok ? <LoginPanel theme={theme} onDone={() => void query.refetch()} /> : null}
    </SettingsSection>
  );
}

function LoginPanel({ theme, onDone }: { theme: PluginTheme; onDone(): void }) {
  const toast = useToast();
  const start = useRpc(loginStartRpc);
  const status = useRpc(loginStatusRpc);
  const login = useMutation({ mutationFn: () => start({}) });
  const loginId = login.data?.loginId;
  const progress = useQuery({
    queryKey: ["god-mode", "login", loginId],
    queryFn: () => status({ loginId: loginId as string }),
    enabled: Boolean(loginId),
    refetchInterval: (q) => (q.state.data?.state === "pending" || !q.state.data ? 2000 : false),
  });
  const state = progress.data?.state;
  useEffect(() => {
    if (state === "done") onDone();
  }, [state, onDone]);

  return (
    <SettingsCard>
      {!login.data ? (
        <SettingsAction
          label="Sign in to ChatGPT"
          hint="You get a link and a code. Open the link on this Mac or your phone, sign in, enter the code."
          actionLabel={login.isPending ? "Starting…" : "Sign in"}
          disabled={login.isPending}
          onPress={() => login.mutate()}
        />
      ) : (
        <View style={{ gap: 10, padding: 14 }}>
          <Text style={{ color: theme.colors.foreground, fontSize: 15 }}>Open the link, sign in to ChatGPT and enter this code:</Text>
          <Text selectable style={{ color: theme.colors.accent, fontSize: 30, fontWeight: "800", letterSpacing: 3 }}>{login.data.userCode}</Text>
          <View style={{ flexDirection: "row", gap: 16 }}>
            <ExternalLink href={login.data.verificationUrl}>Open {new URL(login.data.verificationUrl).host}</ExternalLink>
            <Text
              style={{ color: theme.colors.accent }}
              onPress={() => void copyText(login.data.userCode).then(() => toast.show("Code copied")).catch(() => toast.error("Copying is not available here"))}
            >
              Copy code
            </Text>
          </View>
          <Note
            theme={theme}
            tone={state === "failed" ? "bad" : state === "done" ? "good" : "muted"}
            text={state === "done" ? "Signed in." : state === "failed" ? (progress.data?.error ?? "Sign-in failed. Start again.") : "Waiting for you to finish signing in…"}
          />
          {state === "failed" ? <SettingsAction label="Try again" actionLabel="New code" onPress={() => login.mutate()} /> : null}
        </View>
      )}
      {login.isError ? <SettingsRow label="Could not start signing in" error={errorText(login.error)} /> : null}
    </SettingsCard>
  );
}

export function SiteStep({ theme }: { theme: PluginTheme }) {
  const queryClient = useQueryClient();
  const status = useRpc(releaseStatusRpc);
  const current = useQuery({ queryKey: STATUS_KEY, queryFn: () => status({ log: false }) });
  const [choosing, setChoosing] = useState(false);
  const site = current.data?.site;

  return (
    <SettingsSection title="2 · Your Site">
      {current.isPending ? (
        <SettingsCard>
          <Spinner theme={theme} />
        </SettingsCard>
      ) : site && !choosing ? (
        <SettingsCard>
          <SettingsRow label={site.title} hint={site.url ?? "Not published yet"} />
          <SettingsAction label="Use another Site" actionLabel="Change" onPress={() => setChoosing(true)} />
        </SettingsCard>
      ) : (
        <SitePicker
          theme={theme}
          onChosen={() => {
            setChoosing(false);
            void queryClient.invalidateQueries({ queryKey: STATUS_KEY });
            void queryClient.invalidateQueries({ queryKey: ["god-mode", "preferences"] });
          }}
        />
      )}
      {current.isError ? <Note theme={theme} tone="bad" text={errorText(current.error)} /> : null}
    </SettingsSection>
  );
}

function SitePicker({ theme, onChosen }: { theme: PluginTheme; onChosen(): void }) {
  const list = useRpc(listSitesRpc);
  const connect = useRpc(connectSiteRpc);
  const create = useRpc(createSiteRpc);
  const check = useRpc(checkSlugRpc);
  const sites = useQuery({ queryKey: ["god-mode", "sites"], queryFn: () => list({}) });
  const [title, setTitle] = useState("God Mode");
  const [slug, setSlug] = useState("");
  const connecting = useMutation({ mutationFn: (projectId: string) => connect({ projectId }), onSuccess: onChosen });
  const creating = useMutation({
    mutationFn: async () => {
      const candidate = await check({ slug });
      if (candidate.status !== "available") throw new Error(`"${candidate.slug}" is ${candidate.status}.`);
      return create({ title, slug: candidate.slug });
    },
    onSuccess: onChosen,
  });

  return (
    <View style={{ gap: 12 }}>
      <SettingsCard>
        {sites.isPending ? (
          <Spinner theme={theme} />
        ) : sites.isError ? (
          <SettingsRow label="Could not list your Sites" error={errorText(sites.error)} />
        ) : sites.data.sites.length === 0 ? (
          <SettingsRow label="You have no Sites yet" hint="Create one below." />
        ) : (
          sites.data.sites.map((s) => (
            <SettingsAction
              key={s.projectId}
              label={s.title}
              hint={`${s.url ?? "not published"} · version ${s.latestVersion}`}
              actionLabel="Use"
              disabled={connecting.isPending}
              onPress={() => connecting.mutate(s.projectId)}
            />
          ))
        )}
      </SettingsCard>
      <SettingsCard>
        <SettingsInput label="New Site title" initialValue={title} onChangeText={setTitle} />
        <SettingsInput label="Address" hint="Lowercase letters, digits and hyphens: the start of its chatgpt.site address." placeholder="my-god-mode" initialValue={slug} onChangeText={(text) => setSlug(text.trim().toLowerCase())} />
        <SettingsAction label="Create a private Site" actionLabel={creating.isPending ? "Creating…" : "Create"} disabled={creating.isPending || !slug || !title} onPress={() => creating.mutate()} />
      </SettingsCard>
      {connecting.isError ? <Note theme={theme} tone="bad" text={errorText(connecting.error)} /> : null}
      {creating.isError ? <Note theme={theme} tone="bad" text={errorText(creating.error)} /> : null}
    </View>
  );
}

const MODES: { label: string; value: Preferences["newChatMode"] }[] = [
  { label: "Paseo's default", value: "" },
  { label: "Plan", value: "plan" },
  { label: "Always ask", value: "default" },
  { label: "Accept file edits", value: "acceptEdits" },
  { label: "Auto", value: "auto" },
  { label: "Bypass (no prompts)", value: "bypassPermissions" },
];

export function PreferencesStep({ theme }: { theme: PluginTheme }) {
  const get = useRpc(getPreferencesRpc);
  const set = useRpc(setPreferencesRpc);
  const queryClient = useQueryClient();
  const loaded = useQuery({ queryKey: ["god-mode", "preferences"], queryFn: () => get({}) });
  const [draft, setDraft] = useState<Preferences | null>(null);
  useEffect(() => {
    if (loaded.data) setDraft(loaded.data.preferences);
  }, [loaded.data]);
  const save = useMutation({
    mutationFn: (preferences: Preferences) => set({ preferences }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["god-mode", "preferences"] }),
  });
  if (!draft) {
    return (
      <SettingsSection title="3 · Preferences">
        <SettingsCard>{loaded.isError ? <SettingsRow label="Could not load" error={errorText(loaded.error)} /> : <Spinner theme={theme} />}</SettingsCard>
      </SettingsSection>
    );
  }
  const patch = (change: Partial<Preferences>) => setDraft({ ...draft, ...change });
  const dirty = JSON.stringify(draft) !== JSON.stringify(loaded.data?.preferences);

  return (
    <SettingsSection title="3 · Preferences">
      <SettingsCard>
        <SettingsInput label="Language" hint='A code such as "en" or "de". Empty: answer in whatever language you speak.' initialValue={draft.language} onChangeText={(language) => patch({ language: language.trim() })} />
        <SettingsInput label="Model for new chats" hint="Empty: Paseo's default." initialValue={draft.newChatModel} onChangeText={(newChatModel) => patch({ newChatModel: newChatModel.trim() })} />
        <SettingsInput label="Thinking for new chats" hint="Empty: Paseo's default." initialValue={draft.newChatThinking} onChangeText={(newChatThinking) => patch({ newChatThinking: newChatThinking.trim() })} />
        <SettingsSelect label="Mode for new chats" value={draft.newChatMode} options={MODES} onValueChange={(newChatMode) => patch({ newChatMode })} />
        <SettingsInput
          label="Wait for an answer (seconds)"
          hint="How long a call waits for the agent before saying it is still working, 0 to 25."
          initialValue={String(draft.waitSeconds)}
          onChangeText={(text) => {
            const value = Number(text);
            if (Number.isInteger(value) && value >= 0 && value <= 25) patch({ waitSeconds: value });
          }}
        />
        <SettingsSwitch label="Confirm risky actions" hint="ChatGPT says what will happen and waits for your yes before approvals, stops, updates and rollbacks." value={draft.confirmRisky} onValueChange={(confirmRisky) => patch({ confirmRisky })} />
        <SettingsSwitch label="Keep a call log" hint="In your Site's own database." value={draft.log} onValueChange={(log) => patch({ log })} />
        <SettingsAction label={dirty ? "Unsaved changes" : "Saved on this Mac"} actionLabel={save.isPending ? "Saving…" : "Save"} disabled={!dirty || save.isPending} onPress={() => save.mutate(draft)} />
      </SettingsCard>
      <Note theme={theme} text="Saved preferences reach the Site with the next publish, or right away with Apply settings below." />
      {save.isError ? <Note theme={theme} tone="bad" text={errorText(save.error)} /> : null}
    </SettingsSection>
  );
}

function JobPanel({ theme, job }: { theme: PluginTheme; job: JobView }) {
  const running = job.state === "running";
  const tone = job.state === "succeeded" ? "good" : running ? "muted" : "bad";
  const headline = running
    ? `${job.action === "update" ? "Publishing" : job.action === "rollback" ? "Rolling back" : "Applying settings"}: ${job.step}`
    : job.state === "succeeded"
      ? (job.result?.message ?? "Done.")
      : job.state === "interrupted"
        ? "Interrupted."
        : `Failed${job.critical ? " — production may need you" : ""}.`;
  return (
    <SettingsCard>
      <View style={{ padding: 14, gap: 8 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          {running ? <ActivityIndicator color={theme.colors.accent} /> : null}
          <Text style={{ color: tone === "good" ? theme.colors.statusSuccess : tone === "bad" ? theme.colors.statusDanger : theme.colors.foreground, fontWeight: "600", flexShrink: 1 }}>{headline}</Text>
        </View>
        {job.error ? <Text style={{ color: theme.colors.statusDanger, fontSize: 13 }}>{job.error}</Text> : null}
        {job.log.slice(-5).map((line, i) => (
          <Text key={`${i}-${line}`} style={{ color: theme.colors.foregroundMuted, fontSize: 12, fontFamily: "Menlo" }} numberOfLines={2}>
            {line}
          </Text>
        ))}
      </View>
    </SettingsCard>
  );
}

const PAIRING_TEXT = {
  secret: "Connected to this Mac; the key is stored as a Site secret.",
  plain: "Connected, but the key is not stored as a secret yet. Apply settings to fix that.",
  missing: "Not connected to this Mac yet. Publish or apply settings to connect it.",
  unknown: "Unknown until a Site is chosen.",
} as const;

export function ReleaseStep({ theme }: { theme: PluginTheme }) {
  const status = useRpc(releaseStatusRpc);
  const start = useRpc(releaseStartRpc);
  const queryClient = useQueryClient();
  const current = useQuery({
    queryKey: STATUS_KEY,
    queryFn: () => status({ log: false }),
    refetchInterval: (q) => (q.state.data?.job?.state === "running" ? 3000 : false),
  });
  const run = useMutation({
    mutationFn: (action: JobView["action"]) => start({ action }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: STATUS_KEY }),
  });
  const data = current.data;
  if (!data?.site) {
    return (
      <SettingsSection title="4 · Publish">
        <SettingsCard>{current.isPending ? <Spinner theme={theme} /> : <SettingsRow label="Choose a Site first" hint="Step 2." />}</SettingsCard>
      </SettingsSection>
    );
  }
  const running = data.job?.state === "running" || run.isPending;
  const liveText = data.live ? `Version ${data.live.versionNumber} (${data.live.commit.slice(0, 7)})` : "Nothing published yet";
  return (
    <SettingsSection title="4 · Publish and update">
      <SettingsCard>
        <SettingsRow label="Live" hint={liveText} />
        <SettingsRow label="This plugin" hint={`God Mode ${data.installed}`} />
        <SettingsRow label="Link to this Mac" hint={data.pairing === "secret" ? PAIRING_TEXT.secret : undefined} error={data.pairing === "secret" ? undefined : PAIRING_TEXT[data.pairing]} />
        <ConfirmAction
          label={data.live ? "Update to this plugin's version" : "Publish the Site"}
          hint="Tests, publishes and checks the live plugin; puts the previous version back if the check fails."
          actionLabel={data.live ? "Update" : "Publish"}
          disabled={running}
          onConfirm={() => run.mutate("update")}
        />
        <ConfirmAction label="Apply settings" hint="Writes the preferences and the link to this Mac, then redeploys." actionLabel="Apply" disabled={running || !data.live} onConfirm={() => run.mutate("configure")} />
        <ConfirmAction
          label="Roll back"
          hint={data.releases.length > 1 ? `Back to the release before version ${data.releases[0]}.` : "There is no earlier release yet."}
          actionLabel="Roll back"
          disabled={running || data.releases.length < 2}
          onConfirm={() => run.mutate("rollback")}
        />
      </SettingsCard>
      {data.job ? <JobPanel theme={theme} job={data.job} /> : null}
      {run.isError ? <Note theme={theme} tone="bad" text={errorText(run.error)} /> : null}
    </SettingsSection>
  );
}

export function ChatGPTStep({ theme }: { theme: PluginTheme }) {
  return (
    <SettingsSection title="5 · Use it in ChatGPT">
      <SettingsCard>
        <View style={{ padding: 14, gap: 8 }}>
          <Text style={{ color: theme.colors.foreground, fontSize: 15, lineHeight: 21 }}>
            Open a new chat in ChatGPT, or start voice, and ask: "What are my agents doing?"
          </Text>
          <Note theme={theme} text="If ChatGPT does not know the tools yet, open Plugins → Created by you, choose your Site and press Install or Connect, then start a new chat." />
          <Text style={{ color: theme.colors.accent }} onPress={() => void openExternalUrl("https://chatgpt.com")}>
            Open ChatGPT
          </Text>
        </View>
      </SettingsCard>
    </SettingsSection>
  );
}
