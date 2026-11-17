# mxagent (Python)

asyncio client for the mxagent agent protocol (see the
[protocol reference](https://github.com/Rockykln/mxagent/blob/main/docs/reference/protocol.md)).
Python >= 3.10. Depends on `cryptography`; remote mode additionally needs `websockets`.

```sh
pip install mxagent              # local Unix socket only
pip install "mxagent[remote]"    # plus the encrypted WebSocket transport
```

From a checkout of the main repository: `pip install ./clients/python` (or `"./clients/python[remote]"`).

The package and import name is `mxagent`.

```python
import asyncio
from mxagent import connect

async def main():
    agent = await connect(name="builder")

    @agent.on_message
    async def handle(msg):
        # msg["kind"]: text | attachment | location | poll_started | poll_answer | reaction
        await agent.reply(f"got: {msg['text']}")

    await agent.status("started")
    if await agent.request_approval("Deploy to staging?", detail="commit abc123") == "allow":
        ...
    await agent.wait_closed()

asyncio.run(main())
```

## Connection

| Argument | Env / file key | Default |
|---|---|---|
| `name` | — | required, becomes the room name |
| `instance` | — | random id, one per process (shared by all agents) |
| `client` | — | `mxagent-python/<version>` |
| `version` | — | not sent |
| `socket_path` | `MXA_SOCKET_PATH` | `$XDG_RUNTIME_DIR/mxagent.sock` (same fallback as the daemon) |
| `url` | `MXA_URL` | — |
| `machine` | `MXA_MACHINE` | — |
| `secret` | `MXA_SECRET` | — |
| `config_file` | — | `$XDG_CONFIG_HOME/mxagent/client.env` |
| `reconnect` | — | `True` |
| `request_timeout` | — | `30` seconds |
| `connect_timeout` | — | `15` seconds, per connection attempt (connect, handshake, `welcome`) |
| `dead_link_timeout` | — | `75` seconds without any data from the daemon |
| `retry_auth_failures` | — | `False`: an authentication failure on reconnect closes the agent |

Values come from the arguments first, then the environment, then the env file (`KEY=VALUE`
lines, `#` comments; the `client-<name>.env` file from `mxagentctl add-machine` works as is). A
configured `url` (`ws://` or `wss://`) selects the encrypted WebSocket transport and then requires
`machine` and `secret`; an explicit `socket_path` argument always selects the Unix socket.

Keep the env file private (`chmod 600`): it holds the machine secret. The secret never crosses
the wire; the handshake authenticates both sides and every frame is AES-256-GCM encrypted with a
per-connection key and strict counters.

## API

| Call | Result |
|---|---|
| `await connect(...)` | `Agent`, registered (raises `NotConnectedError`, `AuthenticationError` or `BridgeError` if the first attempt fails) |
| `@agent.on_message` | handler (sync or async) receives the `message` dict |
| `@agent.on_update` | handler for the owner's `@update` request |
| `await agent.reply(text)` | `{"held": bool}`, `held` is true if queued until the owner joins |
| `await agent.status(text)` | one-line notice in the control room |
| `await agent.ask(text)` | question in the control room; the answer arrives as a `message` |
| `await agent.poll(question, options)` | 2–20 options; the choice arrives as `message` kind `poll_answer` |
| `await agent.vote(answer)` | vote in the owner's latest poll (option text or 1-based number) |
| `await agent.react(emoji)` | reaction on the owner's latest message |
| `await agent.request_approval(title, detail=None, request_id=None, timeout=None)` | `"allow"` or `"deny"`; withdrawn with `approval_cancel` on timeout or cancellation |
| `await agent.report_updated(from_version)` / `report_update_failed(error)` | self-update reporting |
| `agent.connected`, `agent.room_id` | link state |
| `await agent.close()`, `await agent.wait_closed()` | shutdown; `Agent` is also an async context manager |

Errors: `BridgeError` (daemon answered with an error), `NotConnectedError`, `RequestTimeoutError`,
`AuthenticationError` (handshake refused or the daemon could not prove the secret), `ConfigError`.

## Behaviour

The Python and JavaScript clients behave the same; differences are listed at the end.

- **Settings**: arguments first, then the environment, then the env file; empty values count as
  unset. An explicit `socket_path` argument always means local mode. Otherwise a configured `url`
  (`ws://` or `wss://`) selects remote mode and then requires `machine` and `secret`; if one is
  missing (or the URL has another scheme) `connect()` raises `ConfigError` (a `ValueError`) instead
  of falling back to the local socket. Without a URL the socket path is `MXA_SOCKET_PATH`, else the
  daemon's default. Remote settings are checked before connecting (also when an `Agent` is built
  from `Settings`): the URL needs a host, the machine name must match `[a-z0-9-]{1,32}` and the
  secret must be 32–256 characters of `[A-Za-z0-9_-]`; it is used verbatim, never trimmed.
- **Instance**: one random id per process, shared by all agents created in it, so a re-created
  agent replaces its own stale link instead of being rejected as a duplicate.
- **Reconnect**: after a drop the agent reconnects with exponential backoff (0.5 s doubling up to
  30 s, ±20 % jitter, reset after a successful `welcome`) and registers again with the same instance.
  Every attempt (connect, handshake, `welcome`) must finish within `connect_timeout`, otherwise the
  link is recycled. With `reconnect=False` the first drop closes the agent and fails everything
  pending.
- **Dead links**: the daemon sends a `heartbeat` line every 30 s on every link. If nothing at all
  arrives for `dead_link_timeout` (75 s), the agent drops the link and reconnects. This works for
  the Unix socket and the WebSocket alike.
- **Handshake**: in remote mode the secure handshake must finish within 10 s; otherwise the link
  is closed with `NotConnectedError` and retried with the normal backoff. Handshake frames over
  1 MiB are rejected. A refused handshake (close code 4003: wrong or revoked secret, or unknown
  machine) and a daemon that cannot prove it knows the secret raise `AuthenticationError`.
- **Try later**: close code 4029 means the daemon refused the connection for a transient reason
  (address lockout, too many pending handshakes or links, handshake timeout). It raises
  `TryLaterError` (a `NotConnectedError`) and is never fatal: on a reconnect the agent waits 60 to
  90 s (random jitter) and tries again, whatever `retry_auth_failures` says. On the first attempt
  `connect()` raises it like any other connection error; retry after a minute.
- **Authentication failures**: on the first attempt `connect()` raises `AuthenticationError`. On a
  reconnect the agent logs an error and closes instead of retrying, because failed handshakes count
  towards the daemon's per-address lockout. With `retry_auth_failures=True` it keeps retrying, but
  waits at least `backoff_max` between such attempts.
- **Requests**: each request raises `RequestTimeoutError` after `request_timeout` (default 30 s).
  Calls made while disconnected wait for the reconnect within that time and then raise
  `NotConnectedError`; requests in flight when the link drops raise `NotConnectedError` and are not
  retried (they may have been delivered). Daemon errors raise `BridgeError`. In remote mode a request
  whose encoded line exceeds 786 408 bytes (the daemon's 1 MiB frame limit) raises `ValueError`
  before anything is sent.
- **Approvals**: pending approvals survive reconnects (a decision made while the link is down is
  lost, so pass `timeout` to bound the wait). Any decision other than `"allow"` counts as `"deny"`.
  When `request_approval` stops waiting without a decision (its `timeout` expires or the calling
  task is cancelled) the agent sends `approval_cancel`, so the daemon ends the Allow/Deny poll.
  `request_id` must be 1–200 characters. `close()` and, without reconnect, a drop fail pending
  approvals with `NotConnectedError`.
- **Close**: `close()` cancels running async handlers and waits for them (a handler may call
  `close()` itself). `start()` / `connect()` interrupted by `close()` raise
  `NotConnectedError("agent is closed")`.
- **Input**: text arguments must be non-empty strings and polls need 2–20 non-empty options
  (`ValueError`). `vote(2)` sends `"2"`; numbers must be integers ≥ 1 (`bool` is rejected).
  `report_update_failed` accepts an exception and sends its message.
- **Inbound**: lines are buffered in linear time, so a large attachment (a 25 MB file is a ~33 MB
  line) does not stall the event loop. Lines longer than 64 Mi characters drop the link (it then
  reconnects); `heartbeat`, unknown message types, messages with an unknown `kind` and malformed
  lines are ignored. `reaction` messages carry `verified` (true only for an encrypted reaction from
  a verified owner session); never treat a reaction as an answer or approval.
- **Errors**: settings, link and daemon errors are `BridgeError`s: `ConfigError`,
  `NotConnectedError` (also for a send on a closed WebSocket; `TryLaterError` for close 4029), `RequestTimeoutError` (also a
  `TimeoutError`), `AuthenticationError`; a rejected `hello` raises `BridgeError("daemon rejected registration: ...")`.

Deliberate differences to the JavaScript client:

- `await connect()` returns a registered agent and raises if the first attempt fails (or takes
  longer than `connect_timeout`); only later drops reconnect in the background. The JavaScript
  `connect()` returns at once and retries until `ready()` resolves.
- Decorators (`on_message`, `on_update`) instead of events; `close()` is a coroutine. There is no
  `approval_result` event: use the return value of `request_approval`.
- Argument errors raise `ValueError` (JavaScript: `TypeError` / `RangeError`).
- The default `client` is `mxagent-python/<version>` (JavaScript: `mxagent/<version>`).
- Timeouts are in seconds; the backoff can be tuned with `Agent(backoff_initial=, backoff_max=)`.

## Tests

```sh
cd clients/python
python3 -m unittest discover -s tests
```

The tests use a fake daemon on a temporary Unix socket and an in-memory WebSocket pair; they need
no network and no `websockets` package. Crypto tests check the vectors in
[protocol-test-vectors.md](https://github.com/Rockykln/mxagent/blob/main/docs/reference/protocol-test-vectors.md).
