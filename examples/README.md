# Examples

Small agents that show how to use the client libraries. Each one connects to a running bridge
daemon, gets its own room in the Matrix space and talks to the owner there.

By default the clients connect to the local Unix socket (`MXA_SOCKET_PATH`, default
`$XDG_RUNTIME_DIR/mxagent.sock`). For an agent on another machine, install the
`client-<name>.env` file from `mxagentctl add-machine` as `$XDG_CONFIG_HOME/mxagent/client.env`
(see the client library's README).

| Example | Language | Shows |
|---|---|---|
| [`js/echo-agent.mjs`](js/echo-agent.mjs) | JS | receiving messages, `reply`, `react`, attachments and locations |
| [`js/approval-gate.mjs`](js/approval-gate.mjs) | JS | `requestApproval` before running a command, result via `status` |
| [`js/cli-bridge.mjs`](js/cli-bridge.mjs) | JS | connecting any line-based terminal program (stdin/stdout) to a room |
| [`python/echo_agent.py`](python/echo_agent.py) | Python | `@agent.on_message`, `reply`, `react` |
| [`python/poll_agent.py`](python/poll_agent.py) | Python | `poll` and acting on the owner's answer |
| [`healthcheck.sh`](healthcheck.sh) | sh | probing `GET /health` from cron, webhook on state changes (see [deployment](../deploy/README.md#monitoring)) |

## JavaScript (Node >= 22)

The JS client has no dependencies; the examples import it from `../../clients/js/index.mjs`.

```sh
node examples/js/echo-agent.mjs [name]
node examples/js/approval-gate.mjs -- make deploy
node examples/js/cli-bridge.mjs --name repl -- python3 -i -u
```

**approval-gate** posts an Allow/Deny poll in its room and waits. It exits with the command's
exit code (128 + signal number if the command was killed), or 77 if the owner denies. The command
runs without a shell; for pipes or `&&` pass `sh -c '...'` explicitly. The full command line is shown
in the room and the control room with every argument shell-quoted, so the owner sees exactly what
runs; arguments (or a working directory) with control characters such as newlines, or with invisible
or direction-changing characters, are refused before asking (exit 2). Do not put secrets on the
command line. The agent name can be set with `MXA_AGENT_NAME`.

**cli-bridge** starts the given program and keeps it running. Every owner message is written to
the program's stdin as one line (newlines become spaces); every non-empty stdout line is
collected and posted back. Output is batched (`CLI_BRIDGE_BATCH_MS`, default 1500), replies are
at least `CLI_BRIDGE_MIN_GAP_MS` apart (default 3000) and split at `CLI_BRIDGE_MAX_CHARS`
(default 3500). At most `CLI_BRIDGE_MAX_PENDING` lines (default 1000) wait to be sent; older ones
are dropped and replaced by a "[... N lines dropped]" line. Invalid values for these variables are
rejected at startup. The last output lines are still posted after the program exits.
stderr stays on the terminal. Programs that buffer stdout when it is not a TTY
need their unbuffered mode (`python3 -u`, `stdbuf -oL ...`). Use it for terminal agents without
MCP support; agents with MCP support should use the MCP adapter.

## Python (>= 3.10)

Install the client (`pip install ./clients/python`) or run the examples from the repository
checkout, where they fall back to `clients/python/src` on the import path (the package is
imported as `mxagent`).

```sh
python3 examples/python/echo_agent.py [name]
python3 examples/python/poll_agent.py /var/log
```

**poll_agent** asks which report to produce (free disk space or the largest files below the
given path), waits for the owner's vote, replies with the result and exits.
