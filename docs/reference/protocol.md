<!--
SPDX-FileCopyrightText: 2026 rockykln
SPDX-License-Identifier: Apache-2.0
-->

# Agent protocol

This is the contract between the **bridge daemon** and **agents** (any AI agent, script or tool).
Every client library and adapter in this repository implements exactly this document.
Types are mirrored in `src/protocol/messages.ts`; keep both in sync.

The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119. Protocol version: 1.0
(there is no version field on the wire; see [Compatibility](#compatibility)).

## Transports

Messages are UTF-8 JSON objects, one per line (NDJSON).

| Transport | Use | Authentication |
|---|---|---|
| Unix socket (`MXA_SOCKET_PATH`, mode 0600) | agent on the same host as the daemon | file permissions; the machine name of such a link is `local` |
| WebSocket (`MXA_WS_LISTEN`, behind TLS) | agents on other machines | per-machine shared secret, see [Secure WebSocket handshake](#secure-websocket-handshake) |

### Framing

- A **line** is one JSON object serialized as UTF-8 and terminated by `\n` (0x0a). Senders MUST NOT put a raw
  `\n` inside a line (JSON escapes it as `\n` in strings anyway) and MUST terminate every line with `\n`.
  Receivers accept `\r\n`, skip blank lines and **silently drop lines that are not valid JSON**.
  A line that is valid JSON but not an object is answered with `error` "malformed request" (no `id`).
- **Unix socket:** a plain byte stream of lines. A line MAY arrive split across reads; several lines MAY arrive in one read.
- **WebSocket:** every WebSocket message is a **text** frame (receivers SHOULD also accept a binary frame holding UTF-8).
  - Handshake messages (`hello`, `challenge`, `proof`) are plaintext: exactly one JSON object per WebSocket message,
    no trailing `\n` required.
  - From `authed` on, every WebSocket message is exactly one [encrypted frame](#encrypted-frames). Its plaintext
    holds one or more **complete** lines; a line never spans two frames. A missing `\n` at the end of the
    plaintext is implied. The daemon seals exactly one line (with its `\n`) per frame.

### Size limits

| What | Limit | On violation |
|---|---|---|
| line, either direction, both transports | 64 MiB (67 108 864 characters, counted as UTF-16 code units) | daemon drops the link |
| inbound WebSocket message at the daemon (handshake or encrypted frame) | 1 MiB (1 048 576 bytes), so at most 786 408 bytes of plaintext per frame | daemon closes with 1009 |
| handshake message at the client | 1 MiB | client aborts the handshake |
| WebSocket message at the client | clients MUST accept at least 128 MiB (one 64 MiB line, encrypted and base64-encoded) | — |

An agent that needs to send more than 786 408 bytes over WebSocket must split the content over several requests;
the daemon never sends large data in the agent → daemon direction anyway (attachments only flow daemon → agent).

Field limits enforced by the daemon (violations are answered with `error`):

| Field | Limit |
|---|---|
| `reply.text`, `status.text`, `ask.text`, `approval_request.title` | 1–16 000 characters after removing control characters (except `\t`, `\n`) and trimming |
| `poll.question` / `poll.options[]` | 1–500 characters / 2–20 options of 1–200 characters each |
| `approval_request.request_id`, `approval_cancel.request_id` | 1–200 characters |
| `approval_request.detail` | optional; if present (and not `null`) it MUST be a string, else `error` "detail must be a string"; shown clipped to 1 500 characters |
| `react.emoji` | 1–32 characters after trimming; see [Reaction keys](#reaction-keys) |
| `hello.client`, `hello.version`, `hello.instance` | control characters removed, trimmed, cut to 100 characters |

### Reaction keys

A reaction key (agent `react.emoji`, and the key of an owner reaction the daemon forwards) is accepted only if it
has 1–32 characters (UTF-16 code units) and contains none of:

- `"` (it would end the quoted snippet in the daemon's `[reaction] …` text),
- control characters (Unicode category Cc),
- format characters (category Cf: bidi overrides, zero-width characters, tag characters), **except** U+200D
  ZERO WIDTH JOINER, which emoji sequences need,
- U+2028 LINE SEPARATOR and U+2029 PARAGRAPH SEPARATOR.

Agent `react` additionally rejects `[` and `]` (they would mimic the `[name]` prefix of daemon messages); the error
texts are "emoji required", "emoji must not contain quotes, control or formatting characters" and "emoji must not
contain brackets". Owner reactions with an unsafe key are dropped silently.

### Names

- **Machine names** match `^[a-z0-9-]{1,32}$` (ASCII only, so the UTF-8 bytes equal the characters).
  The daemon uses `local` for Unix-socket links; remote machines SHOULD NOT be called `local`.
- **Agent names**: the daemon NFC-normalizes and trims the `hello.name` string, then requires
  `^[\p{L}\p{N}._-]{1,64}$` (Unicode letters and digits, `.`, `_`, `-`; no whitespace, because names are
  addressed as `@name`). Names are compared by their **key** = NFC form lower-cased with the Unicode default
  lower-case mapping (JavaScript `toLowerCase()`, not full case folding).
- **Reserved names** (by key, rejected in `hello` with `error` "name \"…\" is reserved"): `all`, `room`, `list`,
  `update`, `control`, `system`, and every property name of JavaScript's `Object.prototype` lower-cased
  (`__proto__`, `constructor`, `hasownproperty`, `isprototypeof`, `propertyisenumerable`, `tolocalestring`,
  `tostring`, `valueof`, `__definegetter__`, `__definesetter__`, `__lookupgetter__`, `__lookupsetter__`) plus
  `prototype`. Clients and adapters that check names locally MUST use exactly this list.
- **New-name quota:** each machine (Unix-socket links count as machine `local`) may create rooms for at most
  **20 new agent names** per daemon run. A `hello` with a name that has no room yet beyond that is answered with
  `error` "too many new agent names from this machine". Names that already have a room are not limited; the count
  resets when the daemon restarts.

### Secure WebSocket handshake

Every remote machine has a name and a secret.

**Secret format.** The secret is a string of 32–256 characters from the base64url alphabet `[A-Za-z0-9_-]`
without padding (`^[A-Za-z0-9_-]{32,256}$`). `mxagentctl` generates 43-character secrets (32 random bytes,
base64url, no padding). The secret is used **verbatim**: its ASCII bytes are the HKDF input. Implementations MUST NOT
trim, decode, re-pad or otherwise normalize it, and MUST refuse a secret that does not match the pattern before
connecting. Secrets MUST be unique per machine and never cross the wire.

**Nonces and MACs.** `nc` (client) and `ns` (daemon) are exactly 16 random bytes in standard padded base64
(24 characters, `^[A-Za-z0-9+/]{22}==$`); a MAC is 32 bytes in standard padded base64 (44 characters,
`^[A-Za-z0-9+/]{43}=$`). Anything else is malformed. Senders MUST produce canonical base64; receivers only check
the pattern (a non-canonical last character is accepted).

**Key schedule** (`||` is concatenation, `0x00` a single zero byte, strings are their UTF-8 bytes,
nonces their raw 16 bytes):

```
root   = HKDF-SHA256(ikm = secret, salt = "mxagent", info = "root-v1", L = 32)
proof  = base64( HMAC-SHA256(key = root, msg = role || 0x00 || machine || 0x00 || nc || ns) )
         role = "client" | "server"
key    = HKDF-SHA256(ikm = root, salt = nc || ns, info = "session-v1" || 0x00 || machine, L = 32)
```

The machine name from the client's `hello` is bound into both proofs and into the session key, so a proof or a
session is only valid for that machine name, and the daemon's `authed` proof confirms the name cryptographically.
It does not replace unique secrets: whoever knows a machine's secret can authenticate as that machine.
Test vectors: [protocol-test-vectors.md](protocol-test-vectors.md).

**Messages:**

1. client → `{"type":"hello","machine":"<name>","nc":"<nc>"}` (plaintext). This handshake `hello` is not the
   agent `hello` below; the agent `hello` follows encrypted after step 4.
2. daemon → `{"type":"challenge","ns":"<ns>"}` (plaintext). Sent for **unknown machines too**
   (with a random throw-away secret) so machine names cannot be enumerated.
3. client → `{"type":"proof","mac":"<proof(client)>"}` (plaintext)
4. daemon verifies the proof in constant time. On success its first **encrypted** frame is
   `{"type":"authed","machine":"<name>","mac":"<proof(server)>"}`.
5. The client verifies `authed.mac` (mutual authentication). Only then it sends lines, starting with the agent
   `hello`. Clients MUST NOT send encrypted frames before `authed` verified. If the challenge is malformed, `authed`
   does not decrypt or its MAC is wrong, the client MUST close the connection and report an authentication error
   (the peer does not know the secret).

The daemon ignores unknown fields in handshake messages; a message of the wrong type for the current step fails the handshake.

### Encrypted frames

```
frame = base64( counter (8 bytes, big-endian) || AES-256-GCM ciphertext || tag (16 bytes) )
IV    = direction (1 byte: 1 = client → daemon, 2 = daemon → client) || 0x000000 || counter (8 bytes, big-endian)
```

Standard padded base64; no additional authenticated data. Counters start at 1 per direction and MUST increase
by exactly 1 per frame; a receiver rejects any other counter (replay, reorder, gap) before decrypting, and updates
its counter only after the tag verified. A sender MUST stop at counter 2^64 − 1. Decrypted plaintext MUST be valid
UTF-8. Any failure (malformed base64, short frame, wrong counter, bad tag, invalid UTF-8) ends the link.

### Close codes and timeouts

| Situation | Daemon action |
|---|---|
| handshake fails: malformed or wrong-step message, invalid machine name or nonce, wrong proof, unknown machine | close **4003** "forbidden" |
| handshake `hello` not received within **3 s** of the upgrade, handshake not finished within **10 s**, or peer closed during the handshake | close **4029** "try later" |
| address rate-limited (10 failed handshakes, or 30 handshakes that timed out or were closed early, per 10 min per IPv4 address or IPv6 /64) or too many unfinished handshakes (**8** per address, 256 total) | close 4029 without a challenge |
| address rate-limited, but a machine authenticated from this address within the last 24 h: the connection is accepted and the handshake `hello` decides; a machine that did not (or whose own failures from this address reached the limit) | close 4029 at the handshake `hello`, without a challenge (does not count as another failure) |
| correct proof, but the machine already has **64** authenticated links | close 4029 instead of `authed` (does not count as a failure) |
| more than 512 WebSocket connections in total | close 4029 |
| peer ignores a 4003 or 4029 close frame | TCP connection dropped after 2 s |
| inbound WebSocket message over 1 MiB | close 1009 |
| after `authed`: frame fails to decrypt (see above), line over 64 MiB, more than 256 queued requests or more than **8 MiB** of queued requests (see below), more than 256 MiB unread output, machine secret revoked, no WebSocket pong for **75 s** | connection dropped without a close frame (the client sees 1006) |
| Unix socket: line over 64 MiB, more than 256 queued requests or more than 8 MiB of queued requests, more than 256 MiB unread output | socket closed |

Queued requests are those waiting behind the request currently being processed; their size is measured as JSON
characters. A single large request on an idle link is never dropped for its size (the field limits reject it).

4003 means authentication failed: wrong proof or unknown machine (the two are deliberately indistinguishable,
so machine names cannot be probed), or a broken handshake. A client SHOULD treat it as fatal and SHOULD NOT retry
automatically (failed attempts count towards the address lockout).

4029 means "try again later": a lockout, a cap or a timeout, never a judgement on the credentials. A client MUST NOT
treat it as fatal; it SHOULD reconnect after **at least 60 s**, with random jitter so that agents behind one address
do not reconnect in step. Any other close means "reconnect with backoff".

### Keepalive

- The daemon sends WebSocket pings every **30 s** and drops a link without a pong for 75 s
  (proxies often drop idle connections after ~100 s).
- The daemon sends a `{"type":"heartbeat"}` line every **30 s** on **every** link (Unix and WebSocket, from the
  moment the link is up, before and after the agent `hello`). It has no `id` and needs no answer.
- Clients SHOULD treat a link as dead when **no line or frame at all** (heartbeat or anything else) arrived for
  **75 s**, close it and reconnect. This works for clients that cannot see WebSocket pings.

## Envelope

- Requests from the agent MAY carry `"id"`. Clients MUST use integers in `0 … 2^53 − 1`, unique among the requests
  still waiting for an answer on that link. The daemon echoes a numeric `id` unchanged and treats a non-numeric
  `id` as absent.
- Every request **with** an `id` gets exactly one answer carrying that `id`: `{"type":"ok","id":…}` (plus optional
  fields, e.g. `held`), `{"type":"error","id":…,"error":"…"}`, or for `hello` `{"type":"welcome","id":…,"room_id":"…"}`
  instead of `ok`.
- A request **without** an `id` gets no answer on success and `{"type":"error","error":"…"}` (no `id`) on failure.
  An `error` without `id` received before `welcome` means the registration failed.
- Requests on one link are processed strictly one at a time in arrival order, so answers arrive in request order.
  Daemon → agent messages without `id` (`message`, `heartbeat`, …) may arrive between them.
- Before a successful `hello` every other request is answered with `error` "send hello first"; a second `hello`
  gets `error` "already registered".

## Agent → daemon

| type | fields | effect |
|---|---|---|
| `hello` | `name`, `client?` (e.g. `"mcp-adapter/1.0"`), `version?`, `instance?` (string, unique per running agent process) | register; creates the agent's room on first use. Same `name` + same `instance` from the same machine replaces an older link of that agent (reconnect); a stale link (dead transport) is replaced too; any other live agent with the same name is rejected. Answer: `welcome {room_id}` |
| `reply` | `text` | message in the agent's own room. `ok.held = true` if queued because the owner has not joined yet |
| `status` | `text` | one-line notice in the control room, prefixed `[name]` by the daemon |
| `ask` | `text` | question in the control room that mentions the owner; owner's reply comes back as a `message` |
| `poll` | `question`, `options[]` (2–20) | poll in the agent's room; the owner's choice comes back as `message` kind `poll_answer` |
| `vote` | `answer`: string (option text, matched case-insensitively) or integer / string of digits (1-based option number) | vote in the owner's latest poll (agent room, or the control room if newer) |
| `react` | `emoji` | reaction on the owner's latest message delivered to this agent |
| `approval_request` | `request_id`, `title`, `detail?` (string) | Allow/Deny poll in the agent's room + mention in the control room; result comes as `approval_result`, see [Approvals](#approvals). `error` "request_id already pending" if an approval with this `request_id` was requested on the same link and has no `approval_result` yet (and was not cancelled) |
| `approval_cancel` | `request_id` | withdraws a pending approval of this agent (requested from the same machine): the daemon ends the Allow/Deny poll (MSC3381 poll end) and posts "Cancelled: \<title\>"; later owner votes on it are ignored. `error` if no approval with that id is pending for this agent. Clients SHOULD send it when they stop waiting (timeout, cancel) |
| `updated` | `from` | agent reports it reloaded its code (see `update`) |
| `update_failed` | `error` | agent reports a failed self-update |

## Daemon → agent

| type | fields |
|---|---|
| `welcome` | `room_id`, `id?` (answer to `hello`) |
| `message` | `kind`, `text`, `sender`, `via` (`"room"` \| `"control"`), `event_id?`, plus kind-specific fields |
| `approval_result` | `request_id`, `decision` (`"allow"` \| `"deny"`; clients treat anything else as deny) |
| `update` | — (owner asked agents to update themselves; optional to implement) |
| `heartbeat` | — (link keepalive every 30 s, see [Keepalive](#keepalive)) |
| `ok` / `error` | `id` (`error`: optional, see [Envelope](#envelope)), `ok`: `held?`; `error`: `error` (human-readable text) |

`message.kind`:

| kind | extra fields | text (human-readable rendering, always present) |
|---|---|---|
| `text` | — | the message |
| `attachment` | `attachment: {name, mime, kind: "image"\|"file"\|"video"\|"audio", data (base64), size}` | caption or empty |
| `location` | `lat`, `lon`, `accuracy_m?`, `description?` | `"[location] lat, lon …"` |
| `poll_started` | `question`, `options[]` | question + options |
| `poll_answer` | `question`, `choices[]` | `"[poll answer] …"` |
| `reaction` | `emoji`, `target_text`, `verified?` | `"[reaction] …"` (contains `(unverified)` when `verified` is false) |

Agents must treat `message` content as **input from the owner**, already verified by the daemon
(encrypted, sent by the configured owner from a cross-signed device). Reactions are the only
unencrypted events forwarded and are never used for approvals. `reaction.verified` is `true` only for a
reaction that was encrypted and passed the owner check; plain reactions (which the homeserver can forge)
have `verified: false`. A missing `verified` field means unverified.

## Approvals

- **Machine binding.** The daemon remembers the machine of the link that sent `approval_request`.
  `approval_result` is sent only to the live link of that agent name **from the same machine**, and
  `approval_cancel` only matches approvals requested from the same machine. If another machine has taken over
  the name meanwhile, the result is not delivered (the room notice says the agent is offline).
- **Expiry.** A pending approval expires after the daemon's approval TTL (`MXA_APPROVAL_TTL_MINUTES`, 1–1440,
  default 15). On expiry the daemon sends `approval_result` with `decision: "deny"` to the requesting agent (same
  machine rule as above; fail-safe so an agent never waits forever), ends the Allow/Deny poll and posts
  "Expired: \<title\>" in the agent room. The same happens to the oldest pending approval when more than 200 are
  pending. Agents SHOULD still use their own timeout (and send `approval_cancel`), because an offline agent misses
  the expiry `deny`.
- **Owner ends the poll** (MSC3381 poll end) while the approval is pending: counts as deny.
- **Late votes.** A vote on an approval that is no longer pending (decided, expired, cancelled) changes nothing;
  the daemon answers it with the notice "Vote not applied, this approval is no longer pending (\<outcome\>):
  \<title\>", where outcome is `allowed`, `denied`, `expired` or `cancelled`.
- Each approval is resolved at most once; the first valid vote wins.
- **Request ids.** A `request_id` must be unique among the approvals still pending on a link; a duplicate is
  rejected (see `approval_request`). After its `approval_result` or a successful `approval_cancel` it may be reused.

## Compatibility

- Receivers MUST ignore unknown fields in every message.
- Agents MUST ignore daemon messages with an unknown `type` and `message`s with an unknown `kind` (a client may
  surface the `text` of an unknown kind, which is always present).
- The daemon answers an unknown request `type` with `error` "unknown request type …".
- New optional fields, message types and kinds may be added in minor versions; existing ones keep their meaning.

## Owner commands in the control room

`@<agent> text`, `@all text` (alias `@room`), `@list`, `@update [agent]`.

**Reply routing:** a reply (`m.in_reply_to`) in the control room goes to the agent behind the replied-to message
only if that message was sent by the daemon itself for the agent **during the current daemon run** (`status`,
`ask`, the approval mention, any `[name] …` message, including held ones once they were sent). The daemon keeps the
last 1000 such ids in memory and never looks up the replied-to event (the reply relation is not covered by the
owner check). Replies to anything else are handled like normal control-room text. A message that starts with an
explicit command (`@name …`, `@all`, `@list`, `@update`) always follows that command, even when it is also a reply.
Edits are never routed as replies.

Polls in the control room go to all agents; their votes are summarized by the daemon (all agents share one bot user, and Matrix
allows one identical reaction / vote per user and event).

## Delivery semantics

- Delivery daemon → agent is **at most once**: a line is written to the agent's current link and never
  acknowledged, repeated or replayed after a reconnect.
- Owner messages are delivered only to connected agents; there is **no queue** for offline agents.
  The daemon marks a delivered owner message with 👀 and an undeliverable one with 💤 (plus a notice in the
  agent room or the system room).
- `approval_result` goes once to the live link of the requesting agent name on the requesting machine. If that
  agent is offline when the owner decides or the approval expires, the result is not delivered (the daemon says so
  in the room for decisions); agents SHOULD treat a timed-out approval as **deny** and send `approval_cancel`.
  See [Approvals](#approvals).
- Messages the daemon sends into a room before the owner has joined it are held (in memory) and sent
  once the owner joins, because Megolm keys only reach joined members (`ok.held = true`).
- If the owner's pinned master key changes, all owner messages are rejected (notice in the agent room, or
  in the system room for control-room messages) until the operator runs `mxagentctl reset-owner-pin` after re-verifying the owner.
- Unknown control-room commands get a notice in the system room.
- Remote agent settings use `MXA_URL`, `MXA_MACHINE`, `MXA_SECRET` (env or `client.env`).
