# @ironflow/agent

An Ironflow coding agent for editors that speak the [Agent Client Protocol](https://agentclientprotocol.com) (ACP), such as Zed and JetBrains IDEs. You describe a function, a saga or a projection. The agent writes the Ironflow code in your project, runs your typecheck and tests, and fixes what fails.

You bring your own model key (Anthropic, OpenAI, Google Gemini or OpenRouter). The agent sends your prompts and the files it reads to that provider. Ironflow does not supply or pay for a model.

The agent carries the Ironflow skills (`ironflow-start`, `ironflow-code`, `ironflow-docs`, `ironflow-ops`, `ironflow-fit`). For exact SDK signatures it fetches the pages that `ironflow-docs` lists from docs.ironflow.run with `curl` in its bash tool, instead of guessing.

## Before you start

You need an Ironflow server for your app. For local work, start one in a second terminal:

```fish
ironflow serve --dev
```

No server yet? `brew install sahina/tap/ironflow` installs the binary.

Platforms: macOS and Linux. On Windows, use WSL. The agent needs Node.js 22.19 or later.

The agent starts one `ironflow mcp` process for each workspace, so it has the Ironflow MCP tools (the tools that list functions, runs and events) under `ironflow serve --dev`. `ironflow` must be on your PATH. The process stops when the agent stops.

If `ironflow mcp` cannot start, the agent tries the server's remote MCP endpoint. The engine refuses that endpoint under `--dev`, because dev mode accepts any token. To use it, run a server with remote MCP on and give the agent a real key:

```fish
env IRONFLOW_MCP_REMOTE=true ironflow serve
```

```zsh
IRONFLOW_MCP_REMOTE=true ironflow serve
```

Then set `IRONFLOW_API_KEY` in the agent config (see the table below). The [Remote MCP guide](https://docs.ironflow.run/how-to-guides/ai-remote-mcp/) explains how to create a key and which role it needs.

If neither works, the agent uses the bundled skills and the `ironflow` command line only. It tells you in its first reply.

## Set your model key

Run the login command once. Pick a provider, then paste the key.

```fish
npx -y @ironflow/agent login
```

The command is the same in zsh.

The key goes to `~/.ironflow/agent/credentials.json` with mode `0600`. If the file is readable by other users, the agent refuses to use it. `npx -y @ironflow/agent logout` removes the key.

You can set an environment variable in the agent config instead. A variable always wins over the stored key.

## Add the agent to your editor

### Zed

Add a custom agent to `settings.json`:

```json
{
  "agent_servers": {
    "Ironflow": {
      "type": "custom",
      "command": "npx",
      "args": ["-y", "@ironflow/agent"],
      "env": { "ANTHROPIC_API_KEY": "..." }
    }
  }
}
```

Leave out `env` if you used `login`. When the agent finds no key, it offers `login` as a terminal login method to editors that support terminal authentication, and such an editor runs the command for you. Other editors show the message that names the login command. Zed also applies `env` to agents that you install from the agent registry.

### JetBrains

Add the agent to `~/.jetbrains/acp.json`:

```json
{
  "agent_servers": {
    "Ironflow": {
      "command": "npx",
      "args": ["-y", "@ironflow/agent"],
      "env": { "ANTHROPIC_API_KEY": "..." }
    }
  }
}
```

Whether a registry install accepts `env` is not confirmed for JetBrains. For a registry install, use the login command. It works the same in both editors.

## Settings

Set these in the `env` block of the agent config, or in your shell.

| Variable | Default | Use |
|---|---|---|
| `ANTHROPIC_API_KEY` | none | Model key for Anthropic. |
| `OPENAI_API_KEY` | none | Model key for OpenAI. |
| `GEMINI_API_KEY` | none | Model key for Google Gemini. |
| `OPENROUTER_API_KEY` | none | Model key for OpenRouter. |
| `IRONFLOW_AGENT_MODEL` | A default for the provider of the key | Model as `provider/model`, for example `anthropic/claude-sonnet-5-5`. |
| `IRONFLOW_AGENT_HOME` | `~/.ironflow/agent` | Where the agent keeps the stored key and the session transcripts. |
| `IRONFLOW_AGENT_SESSION_DAYS` | `30` | The agent deletes session transcripts that are older than this many days when it starts. `0` keeps all of them. |
| `IRONFLOW_SERVER_URL` | `http://localhost:9123` | The Ironflow server the MCP tools talk to. |
| `IRONFLOW_API_KEY` | none | Key for the MCP tools. `ironflow mcp` and the server's remote MCP endpoint both use it. Dev mode needs none. |
| `IRONFLOW_AGENT_ANTHROPIC_BASE_URL` | Anthropic's API | Testing and proxy setting. Sends Anthropic requests to another URL. With it set, only Anthropic is available. |

If more than one provider variable is set, the first one in the table order is used.

## What the agent can do

The file tools and the search tools stay inside your project folder. A path outside it fails, and no prompt can approve it. The agent's own folder (`IRONFLOW_AGENT_HOME`, where the stored key lives) is refused too, even when your project folder contains it. Shell commands are not confined, so read each command before you approve it. An approved shell command can read `IRONFLOW_API_KEY`, because the agent passes it on to your commands.

| Action | What happens |
|---|---|
| Read files, search files, read skills | Runs with no prompt. |
| Read from the Ironflow server (list functions, runs, events, projections, streams, KV keys) | Runs with no prompt. |
| Write or edit a file | Asks first. The prompt carries the diff: the file path, the old text and the new text. |
| Run a shell command that only reads inside your project (`ls`, `cat`, `head`, `tail`, `wc`, `grep`, `rg`, `find`, `sed -n`, `sort`, `uniq`, `cut`, `echo`, `pwd`, `which`, and `cd` inside the project) | Runs with no prompt, with a fixed set of read-only flags for each program. A glob (`*`, `?`) is allowed when every file it matches is inside the project, no match starts with `-` or `.`, and every name in the folders it reads is plain ASCII; `2>/dev/null` and `2>&1` are allowed. Any other flag, a path outside the project, `..`, any other redirect, `$( )` or any other program makes it ask. |
| Run any other shell command | Asks first. The prompt carries the full command. A command with no time limit stops after 10 minutes. |
| Change the Ironflow server (emit an event, invoke a function, append to an entity stream, resume a run, rebuild a projection) | Asks first. |
| Use a tool from an MCP server your editor passes in | Asks first. The title names the server and the tool, as `server: tool`, and the prompt carries the arguments. |
| Ironflow tools beyond the ones above (delete runs, redact data, secrets, SQL) | Not offered to the model. A shell command can still reach them if you approve it. |
| Start sub-agents | Not available. |

At each prompt you can allow once, allow for this session, or reject. "Allow for this session" is kept in memory and ends with the session. For a file or MCP tool it covers that tool. For the shell, "Allow this exact command this session" covers that command text only: a later `npm test` runs with no prompt, but `npm test -- --run` asks again. A command with `$`, a backtick, a glob, a redirect other than `2>/dev/null` or `2>&1`, or a heredoc can only be allowed once. The grant covers the text, not what the command runs: if `npm test` or `bash x.sh` runs a script, a change to that script also runs with no prompt. No mode approves edits for you. If you reject a call, the agent does not retry it.

An MCP server that your editor passes in cannot use the name `ironflow`. The agent skips it and writes a line to its log. This keeps the read-only Ironflow tools separate from tools it cannot vouch for.

Stop a turn with the editor's stop button. Open prompts close, and the turn ends as cancelled. Past sessions reload from the transcripts in `IRONFLOW_AGENT_HOME`. A transcript (`<IRONFLOW_AGENT_HOME>/sessions/*.jsonl`) holds your prompts, the text of the files the agent read and the output of its tools, in plain text. When it starts, the agent deletes transcripts older than `IRONFLOW_AGENT_SESSION_DAYS` days (30 by default). `ironflow-agent logout --purge` deletes all of them.

## Logs

The agent writes logs to stderr, and your editor shows them in its agent log. They carry no prompt text and no keys. Standard output carries ACP messages only.
