# mxagent

Zero-dependency JavaScript client for the mxagent agent protocol
(see the [protocol reference](https://github.com/Rockykln/mxagent/blob/main/docs/reference/protocol.md)). Plain ESM, Node >= 22, types included.

Install it with `npm install mxagent` once the package is published on npm. Until then, install it
from a checkout (`npm install /path/to/mxagent/clients/js`) or import `clients/js/index.mjs` directly
by path as the examples do. There are no dependencies.

```js
import { connect } from "mxagent";

const agent = connect({ name: "builder" });

agent.on("message", async (m) => {
  // m.kind: text | attachment | location | poll_started | poll_answer | reaction
  await agent.reply(`got: ${m.text}`);
});
agent.on("error", (e) => console.error(e.message));

await agent.ready();
await agent.status("started");

const decision = await agent.requestApproval({ title: "Deploy to staging?", detail: "commit abc123" });
if (decision === "allow") {
  // ...
}
```

## Connection

| Option | Env / file key | Default |
|---|---|---|
| `name` | — | required, becomes the room name |
| `instance` | — | random id, generated once per process |
| `client` | — | `mxagent/<version>` |
| `socketPath` | `MXA_SOCKET_PATH` | the daemon's default: `$XDG_RUNTIME_DIR/mxagent.sock`, else `bridge.sock` in `$MXA_STATE_DIR` (or `$XDG_STATE_HOME/mxagent`) |
| `url` | `MXA_URL` | — |
| `machine` | `MXA_MACHINE` | — |
| `secret` | `MXA_SECRET` | — |
| `version` | — | not sent |
| `configFile` | — | `$XDG_CONFIG_HOME/mxagent/client.env` |
| `reconnect` | — | `true` |
| `retryAuthFailures` | — | `false` |
| `requestTimeoutMs` | — | `30000` |
| `handshakeTimeoutMs` | — | `10000` |
| `deadLinkTimeoutMs` | — | `75000` |

Values are taken from the options first, then the environment, then the env file
(`KEY=VALUE` lines, `#` comments; only the four `MXA_*` keys above are read). The file written by
`mxagentctl add-machine` can be used as is. A configured `url` selects remote mode (WebSocket with
the encrypted, mutually authenticated handshake) and then requires `machine` and `secret`;
without a `url`, or with an explicit `socketPath` option, the client uses the local Unix socket.
See Behaviour below for the exact rules.

Keep the env file private (`chmod 600`): it holds the machine secret.

## API

| Call | Result |
|---|---|
| `ready()` | resolves `{ roomId }` after the daemon's `welcome` |
| `reply(text)` | `{ held }` — `held` is true if queued until the owner joins |
| `status(text)` | one-line notice in the control room |
| `ask(text)` | question in the control room; the answer arrives as a `message` |
| `poll(question, options)` | 2–20 options; the choice arrives as `message` kind `poll_answer` |
| `vote(answer)` | vote in the owner's latest poll (option text or 1-based number) |
| `react(emoji)` | reaction on the owner's latest message |
| `requestApproval({ title, detail?, requestId?, timeoutMs?, signal? })` | `"allow"` or `"deny"`; `timeoutMs` / `signal` stop waiting and withdraw the poll |
| `reportUpdated(from)` / `reportUpdateFailed(error)` | self-update reporting |
| `close()` | closes the link, rejects everything pending |

Events: `message`, `approval_result`, `update`, `connected` (`{ roomId }`), `disconnected`, `error`.
Errors are only emitted when an `error` listener is attached.

Error classes, all exported and all subclasses of `BridgeError`:

| Class | When |
|---|---|
| `ConfigError` | thrown by `connect()` / `resolveOptions()` for invalid settings |
| `NotConnectedError` | no link, the link dropped while a request was pending, the link went silent, or the agent is closed |
| `RequestTimeoutError` | the daemon did not answer within `requestTimeoutMs`, or no approval decision within `timeoutMs` |
| `AuthenticationError` | remote handshake failed or the daemon rejected the machine credentials |
| `BridgeError` | the daemon answered a request with `error`, or rejected the registration |

## Behaviour

The JavaScript and Python clients behave the same; differences are listed at the end.

- **Settings**: options first, then the environment, then the env file; empty values count as
  unset. An explicit `socketPath` option always means local mode. Otherwise a configured `url`
  (`ws://` or `wss://`) selects remote mode and then requires `machine` and `secret`; if one is
  missing, the URL does not parse or has another scheme, the machine name does not match
  `^[a-z0-9-]{1,32}$` or the secret is not 32–256 base64url characters (`A-Z a-z 0-9 _ -`, used
  verbatim, never trimmed), `connect()` throws a `ConfigError` instead of falling back to the local
  socket. Non-positive timeouts are a `ConfigError` too. Without a URL the socket path is `MXA_SOCKET_PATH`, else the daemon's default
  (`$XDG_RUNTIME_DIR/mxagent.sock`, else `$MXA_STATE_DIR` or `$XDG_STATE_HOME/mxagent`, `bridge.sock`).
- **Instance**: one random id per process, shared by all agents created in it, so a re-created
  agent replaces its own stale link instead of being rejected as a duplicate.
- **Reconnect**: after a drop the client reconnects with exponential backoff (0.5 s doubling up to
  30 s, ±20 % jitter, reset after a successful `welcome`) and re-sends `hello` with the same instance.
  With `reconnect: false` the first drop closes the agent and rejects everything pending.
- **Handshake**: in remote mode the secure handshake must finish within 10 s
  (`handshakeTimeoutMs`); otherwise the link is closed with an `AuthenticationError` and retried with
  the normal backoff. Handshake frames over 1 MiB (UTF-8 bytes) are rejected and close the link;
  this is a protocol check, not a memory bound (Node's WebSocket has already buffered the frame).
- **Authentication failures**: if the daemon rejects the credentials (close code 4003) or cannot
  prove that it knows the secret, the agent closes: `ready()`, waiting calls and pending approvals
  reject with `AuthenticationError`, which is also emitted as `error`. Retrying would only count
  towards the daemon's lockout (10 failures per 10 minutes per address, shared by every agent behind
  that address). With `retryAuthFailures: true` the client keeps trying, at most once per minute.
- **Try later**: close code 4029 means the daemon refused the connection for a transient reason
  (address lockout, too many pending handshakes or links, handshake timeout). It is never fatal: the
  client emits a `NotConnectedError` and reconnects after 60 to 90 s (random jitter), so agents keep
  running through a lockout. `ready()` and pending approvals keep waiting.
- **Dead links**: the daemon sends a heartbeat line every 30 s. If nothing at all arrives for 75 s
  (`deadLinkTimeoutMs`), in local or remote mode, the client closes the link, emits a
  `NotConnectedError` and reconnects.
- **Requests**: each request rejects with `RequestTimeoutError` after `requestTimeoutMs`
  (default 30 s). Calls made while disconnected wait for the reconnect within that time and then
  reject with `NotConnectedError` (also when the link drops again right after the reconnect);
  requests in flight when the link drops reject with
  `NotConnectedError` and are not retried (they may have been delivered). Daemon errors reject
  with `BridgeError`.
- **Approvals**: pending approvals survive reconnects (a decision made while the link is down is
  lost, so pass `timeoutMs` to bound the wait). Any decision other than `"allow"` counts as `"deny"`.
  When `timeoutMs` expires (`RequestTimeoutError`) or `signal` aborts (rejects with
  `signal.reason`), the client sends `approval_cancel` so the daemon withdraws the poll; treat a
  timeout as a denial. `requestId` must be a non-empty string of at most 200 characters.
  `close()` and, without reconnect, a drop reject them with `NotConnectedError`.
- **Input**: text arguments must be non-empty strings (`TypeError`); polls need 2–20 non-empty
  options (`RangeError` for the count). `vote(2)` sends `"2"`; numbers must be integers ≥ 1.
  `reportUpdateFailed` accepts an `Error` and sends its message.
- **Inbound**: lines longer than 64 Mi characters drop the link (it then reconnects); messages
  with an unknown `kind`, unknown types (such as `heartbeat`) and malformed lines are ignored.
  `reaction` messages carry `verified` (true only for an encrypted reaction from a verified owner
  session); never treat a reaction as an answer or approval.
  Line splitting is linear, so a large attachment does not stall the event loop.
- **Errors**: settings, link and daemon errors are `BridgeError`s: `ConfigError`, `NotConnectedError`,
  `RequestTimeoutError`, `AuthenticationError` (handshake failed or credentials rejected); a
  rejected `hello` rejects `ready()` with `BridgeError("daemon rejected registration: ...")`.
- **Types**: `index.d.ts` declares `Agent extends EventEmitter<AgentEvents>`, which needs
  `@types/node` 20.11 or newer (generic `EventEmitter`). `mxagent/secure` (handshake primitives and
  `newSecret()`) has its own types.

Deliberate differences to the Python client:

- `connect()` returns immediately and keeps trying in the background (also for the first
  attempt); await `ready()` to wait for registration. Python's `await connect()` fails fast if the
  first attempt fails.
- Events instead of decorators; `close()` is synchronous.
- Argument errors use `TypeError` / `RangeError` (Python: `ValueError`); a missing `name` throws
  `TypeError`.
- The default `client` is `mxagent/<version>` (Python: `mxagent-python/<version>`).
- Timeouts are in milliseconds (`requestTimeoutMs`, `timeoutMs`); Python uses seconds.
- Approvals can also be aborted with an `AbortSignal` (`signal`).

## Networks without working IPv6

Node's built-in WebSocket may hang if a host resolves to an IPv6 address that cannot be routed.
The library does not change global DNS settings; start the agent with
`node --dns-result-order=ipv4first` (or `NODE_OPTIONS=--dns-result-order=ipv4first`) if needed.
