const tools: Array<[string, string]> = [
  ["overview", "What needs you, what is running, new replies, projects."],
  ["list_chats", "Find chats by title, workspace, branch or project, archive included on request."],
  ["read_chat", "What was said in the last N turns at once; the commands; the turns; a search."],
  ["search_messages", "Where something was said, across many chats in one call."],
  ["start_chat", "A new chat in a project, with your task as the first message."],
  ["send_message", "A follow-up or an answer to an existing chat."],
  ["answer_approval", "Allow or deny what a chat is waiting for."],
  ["stop_chat", "Cancel what a chat is doing now."],
  ["get_logs", "This plugin's own call log, for troubleshooting."],
];

const settings: Array<[string, string]> = [
  ["PASEO_PAIRING_URL", "Required. The link from `paseo pair`; a full key to your Paseo."],
  ["PASEO_LANGUAGE", "Language to speak with you, e.g. ru. Unset: the language you use."],
  ["PASEO_NEW_CHAT_MODEL / _THINKING / _MODE", "Defaults for new chats; mode bypassPermissions skips every prompt."],
  ["PASEO_WAIT_SECONDS", "How long to wait for a reply before answering \"still working\". Default 15."],
  ["PASEO_CONFIRM_RISKY", "on (default): read back before approvals and stops."],
  ["PASEO_LOG", "on (default): keep a call log in the site database."],
];

export default function Home() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-20 text-zinc-900">
      <p className="text-sm uppercase tracking-widest text-zinc-500">Private MCP server</p>
      <h1 className="mt-4 text-4xl font-semibold">paseo-remote</h1>
      <p className="mt-6">Drive your Paseo agents from ChatGPT, by voice or text, through this site&apos;s plugin.</p>
      <h2 className="mt-12 text-lg font-semibold">Tools</h2>
      <dl className="mt-4 space-y-3">
        {tools.map(([name, text]) => (
          <div key={name}>
            <dt className="font-mono">{name}</dt>
            <dd className="text-zinc-600">{text}</dd>
          </div>
        ))}
      </dl>
      <h2 className="mt-12 text-lg font-semibold">Settings → Environment variables</h2>
      <dl className="mt-4 space-y-3">
        {settings.map(([name, text]) => (
          <div key={name}>
            <dt className="font-mono text-sm">{name}</dt>
            <dd className="text-zinc-600">{text}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-10 text-sm text-zinc-500">Variables apply after the next deploy.</p>
    </main>
  );
}
