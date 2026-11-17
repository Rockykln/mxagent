# MCP adapter

`server.mjs` is a [Model Context Protocol](https://modelcontextprotocol.io) server (stdio transport,
JSON-RPC 2.0) that lets any MCP-capable agent host talk to its owner through mxagent.
It has no dependencies besides the bundled JS client (`clients/js`) and uses only standard MCP
(`initialize`, `ping`, `tools/list`, `tools/call`, `notifications/cancelled`).

Standard MCP cannot push messages into the model. Inbound owner messages are therefore queued in an
**inbox** that the model reads with `bridge_inbox` (non-blocking) or `bridge_wait` (long-poll).
The server sends `instructions` on `initialize` that tell the model how to use the tools.

## Configuration

| Setting | CLI | Environment | Default |
|---|---|---|---|
| Agent name (required, one room per name) | `--name <name>` | `MXA_AGENT_NAME` | — |
| Instance id (same id replaces an older link) | `--instance <id>` | `MXA_INSTANCE` | random per process |
| Local daemon socket | `--socket <path>` | `MXA_SOCKET_PATH` | `$XDG_RUNTIME_DIR/mxagent.sock` (see `clients/js/README.md` for the fallback) |
| Remote daemon (WebSocket URL) | `--url <url>` | `MXA_URL` | — |
| Machine name for remote | `--machine <name>` | `MXA_MACHINE` | — |
| Machine secret for remote | — | `MXA_SECRET` | — |
| Default approval timeout (seconds) | `--approval-timeout <s>` | `MXA_APPROVAL_TIMEOUT_S` | `900` |
| Attachment directory | `--attachment-dir <dir>` | `MXA_ATTACHMENT_DIR` | `$XDG_STATE_HOME/mxagent/attachments` |
| Attachment retention (days, `0` = keep) | `--attachment-retention-days <n>` | `MXA_ATTACHMENT_RETENTION_DAYS` | `7` |

Connection settings not given explicitly are taken from the client env file
(`$XDG_CONFIG_HOME/mxagent/client.env`, as written by `mxagentctl add-machine`), see
[`clients/js/README.md`](../../clients/js/README.md). A URL selects remote mode and then requires
both machine and secret; with a URL but no machine or secret every tool call fails with a
configuration error. `--socket` (or `MXA_SOCKET_PATH`) forces the local socket even if a URL is
configured. Keep the secret in that file (mode 0600) rather than in the host config.

Agent names follow the daemon's rules: 1-64 letters, digits, `.`, `_` or `-` (no spaces, `/`, `:`
or `@`), and not one of the reserved words `all`, `room`, `list`, `update`, `control`, `system` or a JavaScript `Object.prototype` property name such as `__proto__` or `constructor` (any case).
The adapter checks this at startup and exits with an error otherwise. If the daemon still rejects
the registration (for example because another live agent uses the name), tool calls report the
rejection and the adapter stops retrying until it is restarted.

Attachments are written to `<attachment dir>/<agent name>/` with mode 0600; the inbox returns
their local paths instead of the file contents. The directory is set to mode 0700 on every start
and before every save, and files older than the retention period are deleted at startup and
hourly.

## Host configuration

Most MCP hosts accept a JSON server definition like the following. Adjust the path to where the
repository is checked out.

Agent on the same machine as the daemon:

```json
{
  "mcpServers": {
    "bridge": {
      "command": "node",
      "args": ["/path/to/mxagent/adapters/mcp/server.mjs", "--name", "build-agent"]
    }
  }
}
```

Agent on another machine: install the `client-<name>.env` file from `mxagentctl add-machine` as
`$XDG_CONFIG_HOME/mxagent/client.env`. The server definition then only needs the name:

```json
{
  "mcpServers": {
    "bridge": {
      "command": "node",
      "args": ["/path/to/mxagent/adapters/mcp/server.mjs"],
      "env": {
        "MXA_AGENT_NAME": "laptop-agent"
      }
    }
  }
}
```

No binary is installed; always start the adapter with `node`. For a quick manual test from the
checkout: `npm run mcp -- --name test-agent` (it speaks MCP on stdin/stdout).

## Tools

| Tool | Arguments | Result |
|---|---|---|
| `bridge_inbox` | `max?` (default 50, max 500) | up to `max` queued messages, oldest first (rendered text + JSON); `remaining` says how many are still queued |
| `bridge_wait` | `timeout_s` (default 60, max 600), `max?` | like `bridge_inbox`, but waits for the next message if the inbox is empty |
| `bridge_reply` | `text` | message in the agent's room; `held: true` if the owner has not joined yet |
| `bridge_status` | `text` | one-line notice in the control room |
| `bridge_ask` | `text`, `wait?`, `timeout_s?` (default 300, max 600) | question in the control room; with `wait: true` returns the first text message from the owner after the question (never a reaction); other messages stay queued |
| `bridge_poll` | `question`, `options` (2–20) | poll in the agent's room; the choice arrives as a `poll_answer` message |
| `bridge_vote` | `answer` (option text or 1-based number as text, e.g. `"2"`) | vote in the owner's latest poll |
| `bridge_react` | `emoji` | reaction on the owner's latest message to this agent |
| `bridge_request_approval` | `title`, `detail?`, `timeout_s?` (max 86400) | blocks until `allow`, `deny`, `timeout` or `cancelled` (treat anything but `allow` as denied); on timeout or cancel the request is withdrawn and the daemon ends the Allow/Deny poll. The daemon's own expiry (`MXA_APPROVAL_TTL_MINUTES`, default 15) answers `deny` if it comes first |

Each inbox message has `seq`, `received_at`, `kind` (`text`, `attachment`, `location`,
`poll_started`, `poll_answer`, `reaction`, or `update_request` when the owner asked agents to update),
`text`, `sender`, `via` (`room` or `control`) and the kind-specific fields from `docs/reference/protocol.md`.
The inbox holds at most 500 messages; older ones are dropped and the count is reported.

Reactions (`kind: "reaction"`) are not encrypted. They are unverified unless the message carries
`verified: true`, and even then they are only an emoji: never an answer, approval or instruction.
The rendered inbox line and a `note` field on each reaction say so, as do the tool descriptions.

A host that cancels a running tool call (`notifications/cancelled`) ends a pending `bridge_wait`,
`bridge_ask` or `bridge_request_approval` without a response, as the MCP specification requires.

## Autonomous agents

An agent that should keep working without a human at the terminal can loop on `bridge_wait`:
call it, act on the returned messages, report with `bridge_reply` / `bridge_react`, call it again.
Hosts usually enforce their own tool-call timeout; keep `timeout_s` below it.

## Errors

If the daemon is not reachable, tool calls return an MCP tool error (`isError: true`) naming the
socket or URL and the underlying cause, and the server keeps retrying in the background. If the
daemon rejects the registration or the machine credentials, the error says so and the server stops
retrying. A "try later" refusal (close 4029: address lockout, too many connections, handshake
timeout) is not a rejection: the error says so and the server reconnects by itself after 60 to 90 s. A call cancelled while the connection is still being set up performs no action. Logs go to
stderr and never contain message bodies.
