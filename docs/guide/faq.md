# FAQ

## Does it work with my homeserver?

Probably. Any homeserver that supports end-to-end encryption, cross-signing and spaces should
work. You need:

| Feature | Used for |
|---|---|
| end-to-end encryption | all rooms are encrypted |
| cross-signing | checking that messages really come from you |
| spaces | grouping the rooms |
| authenticated media (`/_matrix/client/v1/media`) | attachments |
| password or single sign-on login | logging in the bot |

Polls work in clients with and without the newer stable poll format.

## Why does one bot account serve all agents?

- You verify one bot once, not every agent.
- No accounts to register per agent; many homeservers restrict that.
- Agents never hold Matrix credentials. A new agent just connects with a new name.
- Each agent still gets its own room and display name.

The downside: Matrix allows one vote or identical reaction per account and message, so several
agents cannot each vote on the same control-room poll. The daemon posts a summary instead. See
[commands.md](commands.md#polls-and-votes-in-the-control-room).

## Do agents need Matrix access?

No. The daemon downloads and decrypts attachments itself and passes the file to the agent.
Agents need no access token and no connection to the homeserver.

## Do I need MCP?

No. MCP is one option. You can also use:

- the JavaScript SDK in [`clients/js/`](../../clients/js/README.md), no dependencies,
- the Python SDK in [`clients/python/`](../../clients/python/README.md),
- the raw protocol: one JSON object per line over the Unix socket. Any language with sockets and
  JSON works. Remote agents also need the login handshake, which the SDKs implement for you.

Details: [protocol.md](../reference/protocol.md).

## Can other people talk to my agents?

No. Only `MXA_OWNER` is accepted, and only from verified sessions. Messages from anyone else are
ignored, and the daemon refuses to send into a room that has members besides you and the bot. See
[security.md](security.md#who-can-talk-to-your-agents).

## Can the daemon host read my messages?

Yes. The daemon decrypts everything. See
[security.md](security.md#if-the-daemon-host-is-compromised).

## What happens when an agent is offline?

Your message is not delivered and not queued; the daemon marks it with 💤 and posts a notice.
In the other direction, messages from an agent into a room you have not joined yet are held (in
memory, up to 50 per room) until you join.

An agent notices a dead connection within 75 seconds (the daemon sends a heartbeat every 30
seconds) and reconnects on its own.

## What happens to an approval nobody answers?

It expires after 15 minutes (`MXA_APPROVAL_TTL_MINUTES`) and the agent gets **deny**. See
[commands.md, approvals](commands.md#approvals).

## Two agents with the same name?

The second one is rejected while the first is connected. If the same agent process reconnects
from the same machine, it replaces its old connection. Names are not case-sensitive and may contain letters, digits,
`.`, `_` and `-` (up to 64 characters, no spaces, because agents are addressed as `@name`).
`all`, `room`, `list`, `update`, `control`, `system` and a few names that are special in
JavaScript (such as `constructor` or `__proto__`) are reserved. Each machine can create rooms for
at most 20 new names per daemon run; names that already have a room do not count.

## The daemon says "bot identity not anchored". What now?

Stop the daemon and run `node cli/mxagentctl.ts cross-sign`, then start it again. Until
`cross-sign` has stored the bot's identity, the daemon rejects your messages and sends nothing at
all, not even the `daemon … started` notice in the system room; the reason is only in its log. See
[getting-started.md](getting-started.md#anchor-the-bots-identity).

## The daemon is running but sends nothing. Why?

Look for `refusing to send to …` in the daemon's log. The usual reason is "unverified device(s)":
the daemon sends nothing while any session of your account or of the bot account is not
cross-signed, so a device the homeserver adds cannot read along. Often it is the
client you used to set up the bot's cross-signing. Log that session out, or cross-sign it with the
daemon stopped (`node cli/mxagentctl.ts cross-sign <device-id>`); verify or log out unknown sessions
of your own account. Sending resumes with the next message. See
[security.md](security.md#unknown-device-blocks-sending).

## My remote agent keeps waiting to reconnect. Why?

The daemon closed its connection with code 4029 ("try later"): the agent's address is locked out
after too many failed or aborted logins, or a connection limit was reached. The SDKs and the MCP
adapter wait 60 to 90 seconds and try again on their own. Code 4003 instead means the machine
secret is wrong or was revoked; agents stop and do not retry. To issue a new secret, run
`remove-machine <name>` (if it is still registered) and `add-machine <name> --url …`, then install
the new `client.env` on that machine.

## Can I run several daemons?

Yes, but each needs its own bot account, its own config file and state directory (`MXA_CONFIG`,
`MXA_STATE_DIR`) and its own socket (`MXA_SOCKET_PATH`).
