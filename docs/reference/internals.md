# Daemon internals

Exported API and behaviour of every daemon module. All modules take their dependencies explicitly
(constructor or function arguments); there are no module-level singletons. Modules talk only through the
interfaces listed here, which keeps each one testable with fakes.

Import with the `.ts` extension, types with `import type`.

## Module map

| Module | Role | Depends on |
|---|---|---|
| `config.ts`, `state.ts`, `log.ts` | settings and paths, persisted state, logger | — |
| `matrix.ts` | Matrix client wrapper: login, sync, decryption with sender info, replay store, send guard, hold queue | config, state, log |
| `trust.ts` | owner device verification (bot anchor, cross-signing chain, pinned master key) | `queryKeys` callback |
| `rooms.ts` | agent / control / system rooms in the space, control-room safety check | matrix client, state |
| `registry.ts` | connected agents, name rules, replace/reject, new-room quota | — |
| `commands.ts` | pure control-room command parser | registry (name rules) |
| `router.ts` | inbound owner events → agents | matrix, trust, rooms, registry, media, polls, reactions, updates |
| `media.ts` | attachment download + decryption | config, state (token), `fetch` |
| `polls.ts` | polls, votes, approvals (expiry, cancel) | matrix, rooms, registry, `summarize` |
| `reactions.ts` | receipts, agent reactions, owner reactions, control-room summaries | matrix, rooms, registry |
| `updates.ts` | `@update` fan-out and completion | registry, reactions |
| `machines.ts` | remote machine secrets file | config (paths) |
| `fingerprint.ts` | groups a key in blocks of four for display | — |
| `transport/link.ts` | `Connection` abstraction, NDJSON framing | — |
| `transport/local.ts` | Unix socket listener | link |
| `transport/websocket.ts` | HTTP `/health` + secure WebSocket listener | link, `protocol/secure.ts`, machines (via `secretFor`) |
| `agent-link.ts` | per-connection protocol handler | registry, rooms, matrix, router, polls, reactions, updates |
| `index.ts` | wiring (`createDaemon`), startup, shutdown (`main`) | everything |

## Final wiring (`index.ts`)

```ts
export type DaemonMatrix = Pick<Matrix, "botUser" | "owner" | "onDecrypted" | "onPlainEvent" | "onSent"
  | "onSendRefused" | "onHeldDropped" | "sendMessage" | "sendText" | "sendNotice" | "sendEvent" | "sendRaw"
  | "setTyping" | "getEvent" | "keysQuery" | "healthy" | "start" | "stop">
  & Partial<Pick<Matrix, "isReplay" | "recordReplay" | "setDeviceGuard" | "onDevicesChanged">>
  & { readonly client: RoomsClient };

export interface DaemonDeps {
  config: Config; state: StateStore; log: Logger;
  matrix: DaemonMatrix;                                   // real Matrix or a test fake
  machines: { secretFor(name: string): string | undefined };   // MachineStore
  trust?: RouterTrust;          // default: OwnerTrust over matrix.keysQuery, see below
  fetch?: typeof fetch;         // media downloads
  version?: string;             // default: package.json version
  sweepIntervalMs?: number;     // default SWEEP_INTERVAL_MS = 30000
  updateStaggerMs?: number;     // default 8000 (Updates)
}
export interface Daemon {
  readonly version: string; readonly registry: AgentRegistry; readonly rooms: RoomManager; readonly router: Router;
  readonly wsPort: number | undefined;     // actual port after start() (port 0 allowed in tests)
  system(text: string): void;              // notice in the system room (logged only if there is none yet)
  start(): Promise<void>;                  // throws if called twice
  stop(): Promise<void>;                   // idempotent; also stops a start() in progress
}
export function createDaemon(deps: DaemonDeps): Daemon;
export function packageVersion(): string;  // "unknown" if package.json cannot be read
export function main(): Promise<void>;     // runs only when index.ts is the entry script
export const SHUTDOWN_TIMEOUT_MS = 10000, SWEEP_INTERVAL_MS = 30000;
```

`createDaemon` builds the graph without network access:

```ts
rooms     = new RoomManager({ client: matrix.client, config, state, log })
trust     = deps.trust ?? new OwnerTrust({ queryKeys: matrix.keysQuery, botUser, owner,
              getPinnedMaster: () => state.data.ownerMasterKey,
              getBotMasterKey: () => state.data.botMasterKey,
              getOwnDeviceId: () => state.data.deviceId,
              pinMaster: (k) => { state.data.ownerMasterKey = k; state.save() } })
// only with the default OwnerTrust (without a guard the real Matrix refuses every encrypted send):
matrix.setDeviceGuard?.(() => trust.auditDevices())
matrix.onDevicesChanged?.(() => trust.invalidate())
notify    = { system: (text) => matrix.sendNotice(rooms.systemRoomId, text) }   // errors logged
registry  = new AgentRegistry()
media     = new Media({ config, state, log, fetch })
reactions = new Reactions({ matrix, rooms, registry, log })
matrix.onSent((room, id, content) => reactions.rememberBotMessage(room, id, content.body ?? ""))
polls     = new Polls({ matrix, rooms, registry, log,
              summarize: (id, label, name, prev) => reactions.summarize(id, label, name, prev),
              approvalTtlMs: config.approvalTtlMs })
updates   = new Updates({ registry, reactions, log, notify, staggerMs })
router    = new Router({ config, log, matrix: routerMatrix, trust, rooms, registry, media, polls, reactions, updates, notify })
            // routerMatrix forwards to matrix; without isReplay/recordReplay every event counts as a replay
matrix.onSent(...)          // control-room message "[name] ..." of a known agent -> router.rememberControlMessage
matrix.onSendRefused(...)   // "Refusing to send to <room>: <reason>" in the system room (not for the system room itself)
matrix.onHeldDropped(...)   // "<n> held message(s) for <room> dropped" in the system room (same exception)
roomQuota = new RoomQuota()
onConnection = (conn) => handleConnection(conn, { config, log, matrix, rooms, registry, router, polls, reactions,
                                                  updates, notify, roomQuota })
```

The second `onSent` hook makes every control-room message that starts with `[name]` of a connected agent or one
with a room a reply target, including held messages once they were sent.

`start()`:

1. `router.attach()` (handlers registered before sync starts), `matrix.start()`.
2. `rooms.joinConfigured()`, `rooms.ensureSystemRoom()`, `rooms.ensureControlRoom()` (failures of the last two
   are logged, including `UnsafeRoomError`; the daemon keeps running).
3. System notice `daemon <version> started`.
4. `startLocal({ socketPath, onConnection })`; if `MXA_WS_LISTEN` is set, `startWebSocket({ host, port,
   healthy: matrix.healthy, secretFor: machines.secretFor, trustProxyHeader, onConnection })`.
   A failing listener stops everything and rejects. A `stop()` during `start()` wins: nothing is opened after
   it, and listeners opened meanwhile are closed.
5. Every `sweepIntervalMs`: `registry.sweep()`; each dropped link gets an `<name> offline` notice (its
   transport close handler no longer finds it registered, so there is exactly one notice).

`stop()`: clears the sweep timer, `updates.cancel()`, `polls.close()` (approval expiry timers),
`registry.closeAll()` (before the transports, so closing them does not post one "offline" notice per agent),
closes both listeners, detaches the router, `matrix.stop()`.

`main()`: `loadConfig()` (a `ConfigError` prints the problems and exits with code 2), `paths()`, logger (config
warnings are logged), `StateStore.load`, `createMatrix`, `MachineStore(machinesFile(paths))`, `createDaemon`,
`start()`. SIGINT/SIGTERM run `stop()` and exit 0; if that takes longer than 10 s the process exits with 1.

## `src/daemon/config.ts`

```ts
type LogLevel = "debug" | "info" | "warn" | "error";
const PROXY_HEADER_MODES = ["none", "cf-connecting-ip", "x-forwarded-for"] as const;
type ProxyHeaderMode = (typeof PROXY_HEADER_MODES)[number];

interface Config {
  homeserver: string;          // MXA_HOMESERVER, http(s) URL without query/fragment, trailing "/" removed
                               //   (plain http to a non-local host adds a warning)
  botUser: string;             // MXA_BOT_USER  (@user:server)
  botPassword?: string;        // MXA_BOT_PASSWORD (untrimmed)
  owner: string;               // MXA_OWNER (@user:server, != botUser)
  spaceId: string;             // MXA_SPACE_ID (required, "!…")
  controlRoomId?: string;      // MXA_CONTROL_ROOM_ID ("!…")
  socketPath: string;          // MXA_SOCKET_PATH, default $XDG_RUNTIME_DIR/mxagent.sock,
                               //   fallback <stateDir>/bridge.sock when XDG_RUNTIME_DIR is unset
  wsListen?: { host: string; port: number }; // MXA_WS_LISTEN "host:port", "[v6]:port" or "port" (host 127.0.0.1)
  trustProxyHeader: ProxyHeaderMode;  // MXA_TRUST_PROXY_HEADER (case-insensitive), default "none";
                               //   the old MXA_TRUST_PROXY_HEADERS is rejected with a hint
  recoveryKey?: string;        // MXA_RECOVERY_KEY (adds a warning)
  maxAttachmentBytes: number;  // MXA_MAX_ATTACHMENT_MB * 1 MiB, default 25 MiB, (0, 45] MB (clients cap a line at 64 MiB, base64 adds a third)
  approvalTtlMs: number;       // MXA_APPROVAL_TTL_MINUTES * 60000, whole minutes 1–1440, default 15 minutes
  logLevel: LogLevel;          // MXA_LOG_LEVEL, default "info"
  serverName: string;          // server part of botUser; use as "via" when joining/linking rooms
  warnings: string[];          // non-fatal findings; log them once at startup
}

interface Paths {
  configDir: string;      // dirname(configFile)
  configFile: string;     // $MXA_CONFIG or $XDG_CONFIG_HOME/mxagent/bridge.env (~/.config fallback)
  stateDir: string;       // $MXA_STATE_DIR (environment, else config file) or $XDG_STATE_HOME/mxagent (~/.local/state fallback)
  ssoSessionFile: string; // <stateDir>/sso-session.json (written by `mxagentctl login-sso`; the daemon deletes it after use)
  replayFile: string;     // <stateDir>/replay.log (ReplayStore)
  cryptoDir: string;      // <stateDir>/crypto   (Rust crypto store, SQLite)
  syncFile: string;       // <stateDir>/sync.json
  stateFile: string;      // <stateDir>/state.json
}

class ConfigError extends Error { readonly problems: string[] }   // message lists all problems

function paths(env?: Record<string, string | undefined>, fileVars?: Record<string, string | undefined>): Paths;
function parseEnvFile(text: string): Record<string, string>;
function configFromVars(vars: Record<string, string | undefined>, env?: Record<string, string | undefined>): Config;
function loadConfig(env?: Record<string, string | undefined>): Config;
```

- `paths(env, fileVars)`: `MXA_STATE_DIR` from `env` wins; otherwise it is taken from `fileVars` (read from the
  config file when not given) and only then the XDG default applies.
- `parseEnvFile`: `KEY=value` lines; `#` comments, blank lines, `export KEY=…`, `'single'` and `"double"`
  quotes (double supports `\"`, `\\`, `\n`). Invalid lines are skipped.
- `loadConfig`: reads the file, then overlays every non-empty `MXA_*` variable from `env` (environment wins).
  Missing default file is allowed (env-only setups); missing file named by `MXA_CONFIG` throws `ConfigError`.
  A config file with group/other permission bits adds a warning, so does `MXA_CONFIG` inside the file (no effect).
- `configFromVars`: pure validation (apart from the default socket path); collects all problems and throws one
  `ConfigError`.

## `src/daemon/state.ts`

```ts
interface RoomEntry { roomId: string; name: string }
interface State {
  accessToken?: string; deviceId?: string;
  spaceId?: string; controlRoomId?: string; systemRoomId?: string;
  ownerMasterKey?: string;                 // pinned owner master key (unpadded base64)
  botMasterKey?: string;                   // bot master key verified by `mxagentctl cross-sign` (trust anchor)
  deviceEd25519?: string;                  // ed25519 key of the daemon's device (unpadded base64), written at start
  rooms: Record<string, RoomEntry>;        // key = agentKey(name); null-prototype object, use Object.hasOwn
}
function emptyRooms(): Record<string, RoomEntry>;   // null-prototype map, so "__proto__" is a plain key
function sanitizeState(raw: unknown): State;        // keeps only well-typed fields
function fsyncDir(dir: string): void;               // best-effort directory fsync after a rename

class StateStore {
  readonly file: string;
  readonly data: State;                         // mutate in place, then save()
  constructor(file: string, data: State);       // converts a plain rooms object to a null-prototype one
  static load(file: string): StateStore;        // creates dir (0700); missing file -> empty; bad JSON throws
  save(): void;                                 // durable atomic write, see below; synchronous
}
```

`save()` creates the temp file exclusively with mode 0600 (never follows a symlink or reuses a leftover), fsyncs,
renames and fsyncs the directory; the temp file is removed on failure.

`state.data.spaceId` is not used; the space always comes from `Config.spaceId`.
Only `RoomManager` writes `rooms`, `systemRoomId`, `controlRoomId`; only `login()` writes `accessToken`/`deviceId`;
only the `OwnerTrust` pin callback writes `ownerMasterKey` (`mxagentctl reset-owner-pin` clears it); only
`mxagentctl cross-sign` writes `botMasterKey`; only `Matrix.start()` writes `deviceEd25519` (read by `cross-sign`
to compare the device it signs with the key this daemon holds).

## `src/daemon/log.ts`

```ts
interface Logger {
  debug(...a: unknown[]): void; info(...a: unknown[]): void;
  warn(...a: unknown[]): void;  error(...a: unknown[]): void;
  child(scope: string): Logger;     // prefix "[scope]" (nested: "[a/b]"), same level and sink
  readonly level: LogLevel;
}
interface LoggerOptions { scope?: string; sink?: (level: LogLevel, line: string) => void; now?: () => Date }
function createLogger(level?: LogLevel /* "info" */, opts?: LoggerOptions): Logger;
const silentLogger: Logger;         // for tests
```

Line format: `2026-01-01T00:00:00.000Z INFO  [scope] args…`. Strings verbatim, `Error` as `.message` only,
other values `JSON.stringify`. Default sink: debug/info → stdout, warn/error → stderr.

**Convention (mandatory for every module):** log event/room ids, agent names, sizes, counts, error classes.
Never log message bodies, captions, poll questions/answers, attachment data, access tokens, passwords,
machine secrets or recovery keys.

## `src/daemon/matrix.ts`

```ts
const MEGOLM = "m.megolm.v1.aes-sha2";
const BACKLOG_GRACE_MS = 5000, MAX_HELD_PER_ROOM = 50;

interface SenderInfo {
  device: string | null; curveKey: string | null;
  userId?: string | null;          // user the crypto machine attributes the session to
  claimedEd25519?: string | null;
  forwarded?: boolean;             // room key arrived via m.forwarded_room_key: sender key only claimed
  shield?: { color: number; code: number | null } | null;   // strict shield state, null if unavailable
}
interface MatrixEvent {
  event_id: string; sender: string; type: string;
  room_id?: string;              // always filled before handlers run
  state_key?: string; origin_server_ts?: number;
  content: Record<string, any>; unsigned?: Record<string, unknown>;
  mxa_sender?: SenderInfo;       // only on events decrypted by this daemon's sync loop
  mxa_replay_key?: string;       // replay key of such an event (replayKey); stripped by getEvent
}
type EventHandler       = (roomId: string, event: MatrixEvent) => void | Promise<void>;
type SentHandler        = (roomId: string, eventId: string, content: Record<string, any>) => void;
type RefusedHandler     = (roomId: string, reason: string) => void;
type HeldDroppedHandler = (roomId: string, count: number) => void;
type DeviceGuard        = () => Promise<DeviceAudit>;          // OwnerTrust.auditDevices
type DevicesChangedHandler = (users: string[]) => void;
interface SendResult { eventId: string | null; held: boolean }
interface SsoSession { userId: string; deviceId: string; accessToken: string }
interface DecryptedLike { /* the fields of the crypto library's DecryptedRoomEvent used here */ }

function megolmMessageIndex(ciphertext: unknown): number | null;   // index from a Megolm v1 message, null if malformed
function replayKey(roomId: string, raw: { content?: Record<string, unknown> } | null | undefined): string | null;
function decryptedRaw(raw: Record<string, any>, roomId: string, d: DecryptedLike): Record<string, any>;
function readSsoSession(file: string, log?: Logger): SsoSession | null;   // null if missing; throws if malformed
function login(deps: { config: Config; paths: Paths; state: StateStore; log: Logger; fetch?: typeof fetch }): Promise<void>;
function createMatrix(deps: { config: Config; paths: Paths; state: StateStore; log: Logger; fetch?: typeof fetch }): Promise<Matrix>;
function isDuplicateAnnotation(e: unknown): boolean;       // M_DUPLICATE_ANNOTATION from sendRaw reactions
class OwnerNotJoinedError extends Error {}
class SendRefusedError extends Error { readonly roomId: string; readonly reason: string }
class ReplayLogError extends Error {}          // a replay key could not be appended to the log

class ReplayStore {
  constructor(opts?: { file?: string; cap?: number /* 50000 */; log?: Logger });   // throws on an unreadable/corrupt log
  readonly cap: number;
  readonly size: number;
  has(key: string): boolean;
  add(key: string): boolean;     // false if already known (replay); throws ReplayLogError if not persisted
}

interface MatrixDeps {
  client: MatrixClient; config: Config; log: Logger;
  replay?: ReplayStore;                       // default: in memory only
  state?: StateStore;                         // start() writes state.data.deviceEd25519
  retryMinMs?: number; retryMaxMs?: number;   // held-queue re-check backoff, default 2000 .. 300000
}
class Matrix {
  constructor(deps: MatrixDeps);     // inject a fake client in tests
  readonly client: MatrixClient;     // raw matrix-bot-sdk client (for calls not wrapped here)
  readonly startedAt: number;        // ms epoch of construction
  readonly botUser: string;
  readonly owner: string;
  readonly lastSyncAt: number;       // ms epoch of the last completed sync, 0 before the first

  onDecrypted(cb: EventHandler): () => void;   // all on* return an unsubscribe function
  onPlainEvent(cb: EventHandler): () => void;
  onSent(cb: SentHandler): () => void;
  onSendRefused(cb: RefusedHandler): () => void;
  onHeldDropped(cb: HeldDroppedHandler): () => void;
  onDevicesChanged(cb: DevicesChangedHandler): () => void;   // sync reported device_lists changed/left for owner or bot

  isReplay(key: unknown): boolean;        // missing/invalid key or already recorded
  recordReplay(key: unknown): boolean;    // false = invalid or replay; throws ReplayLogError
  setDeviceGuard(guard: DeviceGuard): void;

  markEncrypted(roomId: string, historyVisibility?: string): Promise<void>;
  isKnownEncrypted(roomId: string): boolean;
  heldCount(roomId: string): number;
  sendMessage(roomId: string, content: Record<string, any>, opts?: { hold?: boolean }): Promise<SendResult>;
  sendText(roomId: string, body: string): Promise<SendResult>;     // m.text, held if needed
  sendNotice(roomId: string, body: string): Promise<SendResult>;   // m.notice, held if needed
  sendEvent(roomId: string, type: string, content: Record<string, any>): Promise<string>;
  sendRaw(roomId: string, type: string, content: Record<string, any>): Promise<string>;
  setTyping(roomId: string, typing: boolean, timeoutMs?: number /* 30000 */): void;
  getEvent(roomId: string, eventId: string): Promise<MatrixEvent>;
  keysQuery(body: unknown): Promise<KeysQueryResponse>;
  healthy(maxAgeMs?: number /* 180000 */): boolean;
  start(): Promise<void>;
  stop(): void;
}
```

Semantics:

- **login order**: existing `state.accessToken`+`deviceId` → `paths.ssoSessionFile` (in the state directory; its
  `userId` must equal `config.botUser`; after it is copied into the state the session file is deleted, a failed
  delete is logged) → password login (`m.login.password`, device name `mxagent (<hostname>)`). Result is saved in
  state. No password and no session file → throws.
- **createMatrix**: sets matrix-bot-sdk log level (WARN, INFO when `debug`), creates `stateDir`, logs in, builds
  `MatrixClient(homeserver, token, SimpleFsStorageProvider(syncFile), RustSdkCryptoStorageProvider(cryptoDir,
  SQLite))` and a `ReplayStore` persisted at `paths.replayFile`. Does not start syncing.
- **Client patches** (per instance, in the constructor): decryption keeps the sender device, curve key, claimed
  key, forwarding chain and shield (`decryptedRaw`) plus a replay key; `getJoinedRoomMembers` throws
  `SendRefusedError` when a room has members besides bot and owner (so Megolm keys are never shared beyond
  them); `createRoom` marks rooms created with Megolm as encrypted; `doSync` records `lastSyncAt` and fires
  `onDevicesChanged` for `device_lists.changed`/`left` entries of owner or bot; `crypto.prepare` wraps the
  OlmMachine's `shareRoomKey` (key-sharing backstop, see send guard); `crypto.encryptRoomEvent` refuses
  (`SendRefusedError`) while that wrapper is not in place.
- **Replay key** (`replayKey`): sha256 over room id, Megolm session id (padding stripped) and the message index,
  parsed from the base64-decoded ciphertext (`megolmMessageIndex`: padded or unpadded base64, version byte 0x03,
  protobuf field 1 = varint index, field 2 = ciphertext bytes, then 8-byte MAC and 64-byte signature; duplicate
  or missing fields, unknown wire types or an index above 2^32 - 1 give null). Session id and index identify one
  message whatever base64 form the homeserver relays. Non-Megolm or unparsable events get no key and are dropped.
- **onDecrypted**: only events that were decrypted (carry `mxa_sender` and `mxa_replay_key`), not sent by the
  bot, not older than `startedAt - BACKLOG_GRACE_MS`, and whose replay key is not recorded (`isReplay`). Matrix
  only checks; the handler records the key with `recordReplay` **after** the owner check and before delivery
  (the router does this synchronously, so a queued duplicate fails `recordReplay`). Untrusted senders therefore
  never take slots in the bounded store. **No trust check is done here**: the router must check `mxa_sender`
  (not forwarded, `userId` equals `sender`), call `OwnerTrust.check(device, curveKey)` and compare
  `event.sender === config.owner` before acting.
- **ReplayStore**: bounded set (oldest dropped beyond `cap`); with a file, an append-only log (mode 0600, opened
  with `O_NOFOLLOW`, fsync per key) compacted atomically when it reaches twice the cap. Fails closed: a log that
  exists but cannot be read, is not a regular file (symlink: `ELOOP`) or has a malformed line makes the
  constructor throw, so `createMatrix` and the daemon refuse to start; fix or remove the file (removing it
  reopens replays of older messages). A failed append throws `ReplayLogError` (key kept in memory); the router
  then does not deliver the event and says "Not delivered: replay log cannot be written." Compaction errors are
  only logged.
- **onPlainEvent**: unencrypted timeline events: `m.reaction`, `m.room.member`, other state, plain messages in
  unencrypted rooms. Excludes bot-sent, decrypted and undecryptable `m.room.encrypted` events. Non-membership
  events older than `startedAt - 5 s` are dropped; membership events always pass. Plain `m.room.message`
  events must never be delivered to agents (only reactions are forwarded unencrypted, see protocol.md).
- Handlers run sequentially in registration order and are awaited; a throwing handler is logged and does not
  stop the others.
- **Send guard**: every encrypted send (`sendMessage`, `sendEvent`, held flushes) first requires that the room is
  known to be Megolm-encrypted (`markEncrypted`, the crypto store, or its `m.room.encryption` state, and the bot
  SDK agrees) and that its joined members are exactly bot and owner (cached for 30 s, reset on membership
  events), and that the device guard (`setDeviceGuard`, `OwnerTrust.auditDevices`) reports no unverified
  device of owner or bot. No guard set → refused ("device check not configured"); a failing key query is not a
  refusal (the message is held like a failed membership lookup). Otherwise it throws `SendRefusedError`;
  `onSendRefused` handlers are told once per room until a send there succeeds again. `markEncrypted` is also
  called for plain `m.room.encryption` events; `isKnownEncrypted` reports the in-memory knowledge.
- **Key-sharing backstop**: the wrapped `shareRoomKey` calls the guard again and keeps a to-device message
  (room key) only if it is Olm-encrypted to exactly the signed curve25519 key in `DeviceAudit.allowedKeys`
  (`keepKeyBound`; other users, `*`, unverified devices and forged keys under an allowed id are removed)
  before the SDK sends it. The wrapped `outgoingRequests` applies the same filter to encrypted to-device
  requests the machine queues itself (key forwards); plaintext ones pass. The wrapped `receiveSyncChanges`
  drops `m.room_key_request` and `m.secret.request` events (`dropGossipRequests`). When the backstop removed
  a recipient, the room's outbound session is invalidated so the next send shares a fresh key. The backstop also covers
  a device list that changed between the check and the SDK's own `/keys/query`. The machine then believes those devices have the session; they get the keys of the next
  session after rotation once verified. Without a guard it throws `SendRefusedError`.
- **Hold queue**: `sendMessage` (and `sendText`/`sendNotice`) queues the content if the owner has not joined
  the room, if the membership check fails (homeserver unreachable) or while earlier messages are still held, and
  returns `{eventId: null, held: true}`. Max 50 per room; dropping older ones fires `onHeldDropped`. The queue is
  re-checked on the owner's join event and with backoff (`retryMinMs` doubling up to `retryMaxMs`) and sent in
  order; `onSent` fires for each. `opts.hold === false` throws (`OwnerNotJoinedError` or the lookup error)
  instead of queueing. `stop()` drops held messages (logged, no `onHeldDropped`). Sends to one room are
  serialized.
- **sendEvent**: any event type (polls, poll responses, edits), encrypted; never held, throws
  `OwnerNotJoinedError` when the owner is not joined. Fires `onSent`.
- **sendRaw**: unencrypted `sendRawEvent` (use for `m.reaction` so clients aggregate it). No guard, not held, no
  `onSent`. Duplicate reactions reject with an error for which `isDuplicateAnnotation(e)` is true; callers
  should ignore those.
- **onSent**: fires after every successful `sendMessage`/`sendEvent`, including held messages when flushed.
- **getEvent**: fetched events never have `mxa_sender` and are not checked against the replay store; never treat
  them as owner input.
- **Invites**: invites sent by the owner are joined automatically (via `config.serverName`); others ignored.
- **start**: logs the device id and its ed25519 fingerprint (`fingerprint.ts`, groups of four characters),
  which `mxagentctl cross-sign` shows again for comparison, and stores the raw key (unpadded base64) in
  `state.data.deviceEd25519` when `deps.state` is given (save errors are logged).
- **healthy**: true while running and the last completed sync is younger than `maxAgeMs` (`start()` counts as a
  sync, giving a grace period). Use for `/health`.
- Media download is not wrapped: use `config.homeserver` + `state.data.accessToken` (Bearer) in `media.ts`.

## `src/daemon/trust.ts`

```ts
interface SignedKeys { user_id?: string; usage?: string[]; keys: Record<string, string>;
                       signatures?: Record<string, Record<string, string>>; [k: string]: unknown }
interface KeysQueryResponse { master_keys?, self_signing_keys?, user_signing_keys?: Record<string, SignedKeys>;
                              device_keys?: Record<string, Record<string, SignedKeys>> }
function canonicalJson(v: unknown): string;
function verifySignature(obj: SignedKeys, signer: string, keyId: string, pubKey: string): boolean;
function crossSigningKey(k: SignedKeys | undefined, user: string, usage: string): string | undefined;
interface DeviceAudit {
  problem: string | null;                                   // null = every device of owner and bot cross-signed
  allowed: ReadonlyMap<string, ReadonlySet<string>>;        // user id -> devices that may receive room keys
}

interface OwnerTrustOptions {
  queryKeys: (body: unknown) => Promise<KeysQueryResponse>;   // matrix.keysQuery
  botUser: string; owner: string;
  getPinnedMaster: () => string | undefined;
  pinMaster: (key: string) => void;
  getBotMasterKey?: () => string | undefined;   // state.botMasterKey; missing = not anchored, nothing is trusted
  getOwnDeviceId?: () => string | undefined;    // state.deviceId; the daemon's device is not audited
  cacheMs?: number;            // default 60000
  now?: () => number;
}
class OwnerTrust {
  constructor(opts: OwnerTrustOptions);
  check(device: string | null | undefined, curveKey: string | null | undefined): Promise<string | null>;
  auditDevices(): Promise<DeviceAudit>;   // never pins; query errors propagate
  invalidate(): void;          // drop cached keys (wired to Matrix.onDevicesChanged)
}
```

`check` returns `null` when trusted, otherwise a short reason suitable for a notice ("unknown sender device",
"bot identity not anchored; run mxagentctl cross-sign", "owner has no cross-signing identity", "owner master key
changed (…)", "bot user-signing key invalid", "owner is not verified by the bot", "owner self-signing key
invalid", "device X unknown", "sender key does not match device", "device X is not verified by the owner").
Chain:

1. The bot master key published by the homeserver equals the locally anchored `getBotMasterKey()` (set by
   `mxagentctl cross-sign`); otherwise nothing is trusted or pinned.
2. Owner master key exists. If a pin exists it must equal it. Without a pin the bot's user-signing key must be
   signed by the bot's master key and must have signed the owner's master key.
3. Owner self-signing key is signed by the owner master key.
4. Device keys exist for `device` (with matching `user_id` and `device_id`), `curve25519:<device>` equals
   `curveKey`, and the device is signed by the owner self-signing key.
5. On full success without a pin, `pinMaster(masterPub)` is called once.

`auditDevices` (send guard, see `matrix.ts`) checks the whole device lists instead of one sender: steps 1–3 as
above (never pins), the bot's self-signing key must be signed by the anchored bot master key, every owner device
must be signed by the owner self-signing key and every bot device except `getOwnDeviceId()` by the bot
self-signing key (matching `user_id`/`device_id`). `problem` names up to 10 unverified devices as
`<user> <device id>` (ids that are not plain are shown as `<invalid id>`); `allowed` lists the signed devices
plus the daemon's own; `allowedKeys` maps each signed device to its signed curve25519 key. A cached result with a problem is re-queried once if the keys are older than 5 s.

Cross-signing keys count only with exactly one ed25519 key whose id is `ed25519:<key>`, the right `user_id` and
usage. Keys are cached for
`cacheMs`; a failing check re-queries once (forced) before returning the reason. Concurrent queries are
coalesced. Query errors propagate (the router treats them as "not delivered").

## `src/daemon/rooms.ts`

```ts
type RoomsClient = Pick<MatrixClient, "createRoom" | "sendStateEvent" | "getJoinedRooms" | "joinRoom" | "leaveRoom"
                                    | "getRoomStateEvent" | "getJoinedRoomMembers" | "inviteUser">;
interface RoomsDeps { client: RoomsClient; config: Config; state: StateStore; log: Logger }
class UnsafeRoomError extends Error { readonly problems: string[] }
class RoomManager {
  constructor(deps: RoomsDeps);
  readonly spaceId: string;
  readonly controlRoomId: string | undefined;   // MXA_CONTROL_ROOM_ID (undefined while unchecked or unsafe), else state
  readonly systemRoomId: string | undefined;
  agentRoom(key: string): string | undefined;
  roomToAgent(roomId: string): string | undefined;   // agent key or undefined (control/system/other)
  agentRooms(): Record<string, RoomEntry>;           // copy (null prototype)
  joinConfigured(): Promise<void>;                   // join space + configured control room, errors logged
  ensureAgentRoom(name: string): Promise<string>;
  ensureSystemRoom(): Promise<string>;
  ensureControlRoom(): Promise<string>;
  checkRoom(roomId: string): Promise<string[]>;      // problems that make a room unsafe; [] = fine
  setDisplayName(roomId: string, displayName: string): Promise<void>;
  removeAgentRoom(key: string): Promise<RoomEntry | null>;
}
```

- Rooms are created with room version 11, preset `private_chat`, `m.megolm.v1.aes-sha2` encryption, join rule
  `invite` (room keys go to every joined member, so only owner and bot may be in it), `history_visibility:
  invited`, guest access forbidden, owner invited, power level 100 for bot and owner, `m.space.parent`
  (canonical) and an `m.space.child` in the space (`via: [serverName]`).
- `ensureAgentRoom(name)`: key = `agentKey(name)`; reuses the stored room if the bot is still joined (updates
  the stored display name, re-invites the owner if they left), otherwise unlinks the old room from the space and
  creates a new room named after the agent. Concurrent calls for one key share the same promise. Saves state.
- `ensureSystemRoom()`: room "system". `ensureControlRoom()`: with `MXA_CONTROL_ROOM_ID` it joins that room and
  runs `checkRoom`; any problem throws `UnsafeRoomError` and `controlRoomId` stays `undefined` (control-room
  traffic is then dropped). Otherwise it reuses `state.controlRoomId` or creates room "control". Both save state
  and re-invite the owner to reused rooms.
- `checkRoom`: Megolm encryption, join rule `invite`, guests forbidden, joined members only bot and owner; a
  failed lookup counts as a problem.
- `setDisplayName`: sets the bot's per-room member display name (call after `hello` with the agent name).
  Best effort.
- `removeAgentRoom(key)`: empties `m.space.child` / `m.space.parent`, leaves the room, deletes the state entry.
  Does not check whether the agent is connected; callers should refuse or close the link first.
- Messages into these rooms go through `Matrix` send helpers; `RoomManager` never sends messages.

## `src/daemon/registry.ts`

```ts
interface AgentLink {
  readonly key: string;        // agentKey(name)
  readonly name: string;
  readonly instance?: string;
  readonly machine: string;    // "local" (Unix socket) or the WebSocket machine name
  readonly version?: string;
  readonly client?: string;
  readonly since: number;      // ms epoch
  send(msg: DaemonMessage): void;
  close(): void;
  alive(): boolean;
}
const RESERVED_NAMES: ReadonlySet<string>;   // "all", "room", "list", "update", "control", "system"
const MAX_NEW_ROOMS_PER_MACHINE = 20;
function agentKey(name: string): string;      // NFC + toLowerCase
function validateAgentName(input: unknown): string;   // trimmed NFC name, or throws Error (client-facing text)
type RegisterResult =
  | { ok: true; replaced?: AgentLink; reason?: "same-instance" | "stale" }
  | { ok: false; error: string; existing: AgentLink };
class AgentRegistry {
  register(link: AgentLink): RegisterResult;
  remove(link: AgentLink): boolean;
  get(key: string): AgentLink | undefined;
  has(key: string): boolean;
  list(): AgentLink[];          // sorted by key
  keys(): string[];             // sorted
  readonly size: number;
  sweep(): AgentLink[];         // remove + close all !alive() links, returns them
  closeAll(): void;
}
class RoomQuota {
  constructor(max?: number /* MAX_NEW_ROOMS_PER_MACHINE */);
  take(machine: string, key: string): boolean;   // reserve a new room; true again for a key already taken
  release(machine: string, key: string): void;   // room creation failed
}
```

- Names: 1–64 chars of letters, digits, `.`, `_`, `-` (Unicode letters allowed, no whitespace because agents are
  addressed as `@name`). Rejected as reserved (by key): `RESERVED_NAMES` and every lower-cased property name of
  `Object.prototype` plus `prototype`, so no lookup can reach the prototype. The MCP adapter keeps the same list.
- `register`: no existing link → added. Existing link → replaced if it is `!alive()` (`reason: "stale"`) or if
  both have the same non-empty `instance` **and the same `machine`** (`reason: "same-instance"`; the instance id is
  client-chosen, so it only counts on the machine that registered it); otherwise rejected with
  `error: 'an agent named "<name>" is already connected'` and the existing link is untouched. Links without
  `instance` never replace a live link. The replaced link is unregistered **before** `close()` is called on it.
- `remove(link)` only removes if that exact object is still registered, so a transport's close handler can call
  `remove(link)` unconditionally; announce "offline" only when it returns true.
- `RoomQuota`: per daemon run, each machine may create rooms for at most `max` new agent names (names without a
  room), so a leaked machine secret cannot fill the space with rooms and invites.
- The registry does not send anything (no welcome, no notices) and does not create rooms; agent-link does that.

## `src/daemon/commands.ts`

```ts
type ControlCommand =
  | { type: "direct"; target: string; text: string }   // target = agent key
  | { type: "broadcast"; text: string }
  | { type: "list" }
  | { type: "update"; target?: string }                // agent key, absent = all
  | { type: "unknown" };
interface ParseOptions { mentionsRoom?: boolean; names?: Iterable<string> }
function parseControlCommand(body: string, opts?: ParseOptions): ControlCommand;
function stripReplyFallback(body: string, formattedBody?: unknown): string;
```

Pure. `@list`, `@update [agent]` (only the first token counts; `@update all` = all), `@all|@room text`
(case-insensitive) and a room mention (`m.mentions.room`, only when the text does not start with `@`) are
broadcasts; other reserved words are `unknown`; `@<name> text` resolves to the longest matching known name
(followed by the end, whitespace, or `:`/`,` plus whitespace), otherwise to the first word. A command without text
is `unknown`. `stripReplyFallback` removes only a real reply fallback (first line `> <@…`, or `<mx-reply>` in the
HTML body); the owner's own `> quote` lines stay.

## `src/daemon/router.ts`

```ts
type ReceiptEmoji = "👀" | "💤";
interface RouterDeps {
  config: Pick<Config, "owner" | "botUser">; log: Logger;
  matrix: RouterMatrix;      // onDecrypted, onPlainEvent, sendNotice, setTyping, isReplay, recordReplay
  trust: RouterTrust;        // check(device, curveKey) -> reason | null
  rooms: RouterRooms;        // controlRoomId, roomToAgent, agentRoom
  registry: RouterRegistry;  // get, list
  media: RouterMedia;        // fetch(content, { encryptedOnly: true })
  polls: RouterPolls;        // ownerEvent(roomId, event) -> PollOutcome
  reactions: RouterReactions;// receipt, rememberDelivery, ownerReaction(roomId, event, verified?)
  updates: RouterUpdates;    // command(roomId, eventId, target?)
  notify: { system(text: string): void };
}
const POLL_EVENT_TYPES: ReadonlySet<string>;
function parseLocation(content): ParsedLocation | null;   // geo URI -> lat/lon/accuracy/description/text
function formatAgentList(links: AgentLink[]): string;      // "name · machine · version · since" per line
class Router {
  constructor(deps: RouterDeps);
  attach(): () => void;                                    // registers handleDecrypted + handlePlain
  readonly handleDecrypted: EventHandler;                  // serialized per room
  readonly handlePlain: EventHandler;                      // owner m.reaction only
  rememberControlMessage(eventId: string, key: string): void;   // bot control-room event -> agent (last 1000)
  deliver(key: string, message: InboundMessage, origin: Origin): boolean;   // 👀 + rememberDelivery, or 💤
}
```

Decrypted events are handled one at a time per room, and only if the sender is the owner, the room is an agent
room or the control room, the room key was not forwarded, `mxa_sender.userId` (if present) equals the sender, and
`trust.check` passes. Events whose replay key is missing or recorded (`matrix.isReplay`) are dropped first;
after a passed check the key is recorded with `matrix.recordReplay` in the same synchronous step (false →
dropped as a replay; a throw → rejected with "replay log cannot be written"). Keys are never recorded for other
senders or rejected events. A rejection posts `Not delivered: <reason>.` in the agent room, or a system notice for
the control room; a throwing check counts as rejection. Then:

- **reactions**: a decrypted owner `m.reaction` that passed all checks goes to
  `reactions.ownerReaction(roomId, event, true)` (forwarded as `verified: true`); plain owner reactions via
  `handlePlain` call `ownerReaction(roomId, event)` (default `verified = false`).
- **agent room**: text/notice/emote (edits as `[edited] …`; edits of non-text messages are ignored; reply
  fallbacks stripped), `m.location`, media (downloaded only when the agent is connected; only encrypted `file`
  media, a plain `url` is refused; only `MediaError` texts reach the owner) → `message` with `via: "room"`, 👀 + typing indicator; offline → 💤 + notice. Poll events go to
  `polls.ownerEvent`.
- **control room**: a reply goes to the agent behind the replied-to event only if that id is in the in-memory map
  filled by `rememberControlMessage` (daemon-sent messages of this run; the relation is not covered by the owner
  check, so there is no lookup); an explicit leading `@command` always wins, edits are never replies. Otherwise
  `parseControlCommand`: `list` → notice, `update` → `updates.command`, `direct` → one agent, `broadcast` → all
  connected agents (one 👀 if anyone got it, else 💤; missed agents in a system notice). Unknown input and non-text
  messages get a hint in the system room; notices name a target only if it is a known agent.

## `src/daemon/media.ts`

```ts
const MEDIA_TIMEOUT_MS = 60000;
class MediaError extends Error {}                          // message is safe to show to the owner
function parseMxc(uri: unknown): { server: string; mediaId: string };   // strict server name + media id check
interface MediaDeps { config: Pick<Config, "homeserver" | "maxAttachmentBytes">;
                      state: { data: Pick<State, "accessToken"> }; log: Logger; fetch?: typeof fetch; timeoutMs?: number }
interface MediaResult { attachment: Attachment; caption: string }
class Media {
  constructor(deps: MediaDeps);
  fetch(content: any, opts?: { encryptedOnly?: boolean }): Promise<MediaResult>;
}
```

Downloads via the authenticated `/_matrix/client/v1/media/download/{server}/{id}` endpoint (Bearer token),
streams with a size cap (`info.size`, `Content-Length`, the running total and the decrypted size are all
checked), decrypts encrypted attachments (`content.file`) with the Rust crypto `Attachment.decrypt`. Caption =
`body` when `filename` is set and differs from it; the name is cleaned. Errors (`MediaError`): no media URL,
invalid media URL, unsupported message type, file too large, download failed (HTTP status / network error /
connection interrupted), download timed out, decryption failed, unencrypted attachment refused (with
`encryptedOnly`, set by the router for every message: a plain `url` is not hash-checked, so the homeserver could
swap the bytes).

## `src/daemon/polls.ts`

```ts
const POLL_START_TYPES, POLL_RESPONSE_TYPES, POLL_END_TYPES: ReadonlySet<string>;   // stable + unstable MSC3381
function approvalAnswerIds(): { allow: string; deny: string };   // fresh random 128-bit hex ids per approval poll
const MAX_QUESTION_CHARS = 500, MAX_OPTION_CHARS = 200, MAX_DETAIL_CHARS = 1500, MAX_OPTIONS = 20;
const DEFAULT_APPROVAL_TTL_MS = 900000;
function parsePollStart(content): { question: string; answers: { id: string; text: string }[] } | null;
function parsePollResponse(content): { ref: string; selections: string[] } | null;
function renderPoll(question: string, options: string[], ids?: string[]): Record<string, any>;   // unstable MSC3381 + text fallback; ids default a0..aN-1
interface PollsDeps {
  matrix: Pick<Matrix, "sendEvent" | "sendNotice">;
  rooms: Pick<RoomManager, "agentRoom" | "roomToAgent" | "controlRoomId">;
  registry: Pick<AgentRegistry, "get" | "keys">; log: Logger;
  summarize: (controlEventId: string, label: string, agentName: string, previousLabel?: string) => Promise<void>;
  now?: () => number;
  approvalTtlMs?: number;      // default DEFAULT_APPROVAL_TTL_MS
}
class Polls {
  constructor(deps: PollsDeps);
  ownerEvent(roomId: string, event: MatrixEvent): Promise<OwnerEventResult>;   // null | delivery | { handled: true }
  sendAgentPoll(agentKey: string, question: string, options: string[]): Promise<string>;
  vote(agentKey: string, agentName: string, answer: string): Promise<void>;
  requestApproval(agentKey: string, agentName: string, requestId: string, title: string, detail?: string): Promise<void>;
  cancelApproval(agentKey: string, requestId: string): Promise<void>;   // throws if none pending
  close(): void;               // clears approval expiry timers (shutdown)
}
```

- Owner poll starts become `poll_started` messages (agent room → that agent, control room → all agents). Owner
  responses to an agent poll become `poll_answer`. Ending an owner poll stops votes on it.
- `vote` picks the owner's newest poll (own room or control room); an answer is an option text
  (case-insensitive) or a 1-based number. In the control room the vote is summarized via `summarize` instead of a
  real vote (all agents share one bot user); a changed vote passes the previous label so the agent is removed
  from that option's summary.
- **Approvals**: `requestApproval` sends an Allow/Deny poll and remembers the requesting link's **machine**. The
  first owner response (`a0`/`a1`) or an owner poll end (= deny) decides: `approval_result` goes only to a live
  link of that agent from the same machine, then `Allowed: …` / `Denied: …` (with `(<name> is offline, not
  delivered)` otherwise). After `approvalTtlMs` (or when more than 200 are pending, oldest first) an approval
  **expires**: `approval_result` `deny` to the agent (same machine rule; fail-safe), poll end and `Expired: …`.
  `cancelApproval` (only from the requesting machine) ends the poll with `Cancelled: …`. Every closed approval is
  remembered (last 2000); a later owner vote on it gets the notice `Vote not applied, this approval is no longer
  pending (<outcome>): <title>`. Approvals leave the pending set synchronously before any await, so they resolve
  at most once.
- Polls are sent with `sendEvent`, so they fail with `OwnerNotJoinedError` before the owner joined.

## `src/daemon/reactions.ts`

```ts
const MAX_EMOJI_LENGTH = 32;
function safeReactionKey(key: string): boolean;   // 1–32 chars, no ", Cc, Cf (except ZWJ U+200D), U+2028/2029
interface ReactionsDeps { matrix: Pick<Matrix, "sendRaw" | "sendMessage" | "owner">;
                          rooms: Pick<RoomManager, "controlRoomId" | "roomToAgent">;
                          registry: Pick<AgentRegistry, "get">; log: Logger }
class Reactions {
  constructor(deps: ReactionsDeps);
  receipt(roomId: string, eventId: string, emoji: string): Promise<void>;   // unencrypted m.reaction, never throws
  rememberDelivery(agentKey: string, roomId: string, eventId: string): void;
  agentReact(agentKey: string, agentName: string, emoji: string): Promise<void>;
  summarize(eventId: string, label: string, agentName: string, previousLabel?: string): Promise<void>;
  rememberBotMessage(roomId: string, eventId: string, text: string): void;   // fed by matrix.onSent
  ownerReaction(roomId: string, event: MatrixEvent, verified?: boolean /* false */): Promise<void>;
}
```

- `agentReact` validates the key (`safeReactionKey`, plus no `[`/`]`) and reacts on the owner's latest message
  delivered to that agent; in the control room it also adds the agent to a summary notice.
- `summarize`: one notice per (event, label), a reply to the event, edited as names are added (`👍 a, b`);
  `previousLabel` first removes the agent from that label's notice (shown as `(none)` when empty). Edits of one
  notice are serialized.
- `ownerReaction`: forwards an owner reaction with a safe key on a bot message **remembered from this run** in
  the same agent room to the live agent as `message` kind `reaction` with `verified` (text gets `(unverified)`
  when false). Unknown targets are ignored (never fetched: a fetched event could be altered by the homeserver).
- Duplicate-annotation errors from `receipt` are ignored.

## `src/daemon/updates.ts`

```ts
const UPDATE_BASE_TIMEOUT_MS = 60000, UPDATE_PER_AGENT_MS = 10000;
interface UpdatesDeps { registry: Pick<AgentRegistry, "get" | "list">; reactions: Pick<Reactions, "receipt">;
                        log: Logger; notify: { system(text: string): void }; staggerMs?: number /* 8000 */; now?: () => number }
class Updates {
  constructor(deps: UpdatesDeps);
  command(roomId: string, eventId: string, target?: string): Promise<void>;
  reported(key: string, version: string | null): void;   // "updated" -> link version ("" if none), "update_failed" -> null
  readonly active: boolean;
  cancel(): void;              // stops pending sends and tracking (shutdown or replacement)
}
```

Sends `update` to the targeted live agents: machines in parallel, agents on one machine `staggerMs` apart (a
delayed send is skipped if the link was replaced meanwhile). Tracking starts before anything is sent. 👀 on the
command. When every target reported success with one common version → ✅ + `Update complete: …`; failures, missing
reports (timeout 60 s + 10 s per agent) or mixed versions → ⚠️ + `Update incomplete (…)`. Reports from agents that
were not targeted are ignored. A new command replaces a pending one; a stale timer cannot end a newer run.

## `src/daemon/machines.ts`

```ts
const MACHINE_NAME_RE = /^[a-z0-9-]{1,32}$/;
function machinesFile(p: Pick<Paths, "configDir">): string;   // <configDir>/machines
function validateMachineName(input: unknown): string;          // throws Error with a user-facing message
function parseMachines(text: string): Map<string, string>;
function parseMachinesFile(text: string): { map: Map<string, string>; lines: string[]; invalid: number[] };
interface MachineStoreOptions {
  log?: Logger;
  missingGraceMs?: number;   // 2000: a missing/empty file revokes all machines only after this long
  lockTimeoutMs?: number;    // 5000: how long a writer waits for <file>.lock
  staleLockMs?: number;      // 30000: older lock files are removed
  now?: () => number;
}
class MachineStore {
  constructor(file: string, opts?: MachineStoreOptions);
  readonly file: string;
  secretFor(name: unknown): string | undefined;
  addMachine(name: string, opts?: { replace?: boolean }): string;   // returns the new secret
  removeMachine(name: string): boolean;
  listMachines(): string[];
}
function takeOverStaleLock(lock: string, stale: Pick<fs.Stats, "ino" | "dev">): boolean;   // rename + inode re-check; true if removed
// convenience wrappers on the default file: defaultMachineStore, secretFor, addMachine, removeMachine, listMachines
```

File format: `<name> <secret>` per line (secret `^[A-Za-z0-9_-]{32,256}$`), mode 0600, written atomically under a
lock file. Blank, comment and malformed lines are ignored and kept on rewrite; the first entry for a name wins
(`invalid` lists the 1-based numbers of ignored entry lines, which are logged). Reads re-check the file's stat, so
`mxagentctl add-machine` / `remove-machine` take effect in the running daemon without a restart; read errors keep
the last good list. The WebSocket sweep then closes open links of a removed machine within one ping interval
(30 s).

## `src/daemon/transport/link.ts`

```ts
interface Connection {
  readonly machine: string;            // "local" or the authenticated machine name
  write(line: string): void;           // one NDJSON line ("\n" added if missing); no-op once closed
  close(): void;
  alive(): boolean;
  onLine(cb: (obj: unknown) => void): void;   // lines before the first onLine() are queued
  onClose(cb: () => void): void;              // called at once (microtask) if already closed
}
const MAX_LINE_LENGTH = 64 MiB, MAX_BUFFERED_OUTPUT = 256 MiB, DEFAULT_ALIVE_MS = 75000;
class LineSplitter { constructor(emit, maxLine?); push(chunk: string): boolean }   // false: line too long
function socketConnection(sock: net.Socket, machine: string, opts?: { maxLine?: number; maxBufferedOutput?: number }): Connection;
interface WsConnectionOptions { maxLine?: number; maxBufferedOutput?: number; aliveMs?: number; now?: () => number }
function wsConnection(ws: WebSocket, cipher: Cipher, machine: string, opts?: WsConnectionOptions): Connection;
function rawToString(data: unknown): string;
```

Invalid JSON lines are skipped; an over-long line or a peer that does not read (a write that would take the
buffered output above `maxBufferedOutput`; a write to an empty buffer always goes out) closes the connection.
WebSocket links decrypt every frame (tampered, replayed or reordered frames close the link) and count as dead when
no pong arrived within `aliveMs`.

## `src/daemon/transport/local.ts`

```ts
interface LocalOptions { socketPath: string; log: Logger; onConnection: (conn: Connection) => void }
interface LocalServer { close(): Promise<void> }
function startLocal(opts: LocalOptions): Promise<LocalServer>;
function probeSocket(socketPath: string, timeoutMs?: number /* 1000 */): Promise<"free" | "in-use" | "unknown">;
```

Creates the parent directory (0700). An existing path must be a socket; it is removed only when `probeSocket`
says "free" (ECONNREFUSED/ENOENT) and refused when "in-use" or "unknown" (other errors, timeout). Binds with umask
0177 and sets mode 0600. Machine name `local`. `close()` destroys open sockets and unlinks the file.

## `src/daemon/transport/websocket.ts`

```ts
interface WebSocketOptions {
  host: string; port: number; log: Logger;
  healthy: () => boolean;                         // GET /health: 200 "ok" or 503 "stale"
  secretFor: (machine: string) => string | undefined;
  onConnection: (conn: Connection) => void;
  trustProxyHeader?: ProxyHeaderMode;             // "none" (default) | "cf-connecting-ip" | "x-forwarded-for"
  helloTimeoutMs?: number;                        // 3000 until the handshake hello
  handshakeTimeoutMs?: number;                    // 10000 for the whole handshake
  pingIntervalMs?: number;                        // 30000, also the sweep interval
  aliveMs?: number;                               // 75000
  maxFailures?: number; failureWindowMs?: number; // 10 failures per 600000 ms lock an address out
  trustedLoginMs?: number;                        // 86400000: machines that authenticated from an address pass its lockout
  maxPendingPerAddress?: number;                  // 8 unfinished handshakes per address
  maxPendingTotal?: number;                       // 256 unfinished handshakes in total
  maxSoftFailures?: number;                       // 30 timed-out or early-closed handshakes per failureWindowMs lock an address out
  maxConnections?: number;                        // 512 WebSocket connections in total
  maxLinksPerMachine?: number;                    // 64 authenticated links per machine
  maxTrackedAddresses?: number;                   // 10000 entries in the failure table
  now?: () => number;
}
function startWebSocket(opts: WebSocketOptions): Promise<WebSocketServerHandle>;   // { port, close() }
function clientAddress(req: http.IncomingMessage, mode?: ProxyHeaderMode): string;
function parseForwardedAddress(value: string): string | undefined;   // strips port/brackets; undefined if not an IP
function rateLimitKey(addr: string): string;     // IPv4 (also IPv4-mapped) as is, IPv6 by its /64
const MAX_INBOUND_FRAME = 1 MiB;
const CLOSE_FORBIDDEN = 4003;                    // authentication failed (clients treat it as fatal)
const CLOSE_TRY_LATER = 4029;                    // transient refusal (clients reconnect after 60-90 s)
```

- Implements the handshake of `protocol.md`: unknown machines get a challenge with a throw-away secret. A malformed
  or wrong-step message, an invalid machine name or nonce, a wrong proof or an unknown machine is a **hard** failure:
  close 4003, counted towards `maxFailures`. A timeout (`helloTimeoutMs`, `handshakeTimeoutMs`) or a peer close
  during the handshake is a **soft** failure: close 4029, counted at most once per window towards `maxFailures` and
  every time towards `maxSoftFailures`. Reaching either limit locks the address out until the window ends; a
  successful handshake clears both tables for the address.
- `clientAddress` reads only the configured header: `CF-Connecting-IP` as a single value, `X-Forwarded-For` by its
  right-most entry; a missing or invalid header falls back to the socket address. With mode `none` the first
  connection from a private address logs a hint to set `MXA_TRUST_PROXY_HEADER`.
- Every refusal that is not about the credentials closes with 4029: connections above `maxConnections`, above the
  pending caps or from a locked-out address (without a challenge). During a lockout, machines that authenticated
  from that address within `trustedLoginMs` still get through; the decision is made at the handshake hello (others
  get 4029 there, without a challenge and without counting another failure; a trusted machine whose own failures
  from that address reached the limit is refused too). A correct proof for a machine that already has
  `maxLinksPerMachine` links gets 4029 instead of `authed` (not counted). A peer that ignores the close frame is
  dropped after 2 s. The failure tables are bounded; active lockouts are never evicted.
- Every `pingIntervalMs` the sweep pings live links, closes dead ones and closes links whose machine secret
  changed or was removed (constant-time compare). Other HTTP requests get 426. Upgrade requests must arrive within
  15 s (headers) / 20 s.

## `src/daemon/agent-link.ts`

```ts
interface AgentLinkDeps {
  config: Pick<Config, "owner">; log: Logger;
  matrix: Pick<Matrix, "sendText" | "sendNotice" | "sendMessage" | "setTyping">;
  rooms: Pick<RoomManager, "ensureAgentRoom" | "setDisplayName" | "controlRoomId"> & Partial<Pick<RoomManager, "agentRoom">>;
  registry: Pick<AgentRegistry, "register" | "remove">;
  router: Pick<Router, "rememberControlMessage">;
  polls: Pick<Polls, "sendAgentPoll" | "vote" | "requestApproval" | "cancelApproval">;
  reactions: Pick<Reactions, "agentReact">;
  updates: Pick<Updates, "reported">;
  notify: { system(text: string): void };
  roomQuota?: RoomQuota;       // without it (tests) new rooms are not limited
  now?: () => number;
  heartbeatMs?: number;        // default HEARTBEAT_INTERVAL_MS (30000); 0 disables heartbeats
}
const MAX_TEXT_CHARS = 16000;
const MAX_QUEUED_BYTES = 8 MiB;
function handleConnection(conn: Connection, deps: AgentLinkDeps): void;
function mentionContent(owner: string, name: string, text: string): Record<string, any>;
```

Requests of one connection are handled strictly in order. The link is dropped when more than 256 requests are
queued, or when requests wait behind another one and their size (JSON characters) would exceed `MAX_QUEUED_BYTES`
(a single large request on an idle link is fine). Every request with a numeric `id` gets exactly one answer:
`welcome` for `hello`, otherwise `ok` or `error`; malformed requests and requests without `id` that fail get an
`error` without `id`. Everything except `hello` is rejected until the hello succeeded. A `heartbeat` line goes out
every `heartbeatMs` from the moment the link is up.

| Request | Handling |
|---|---|
| `hello` | `validateAgentName`; a name without a room takes a `roomQuota` slot (`error` "too many new agent names from this machine" when used up; released if room creation fails); `rooms.ensureAgentRoom` **before** registering, so nothing reaches the agent before its welcome; `registry.register` (rejection → `error`); `welcome {room_id}` synchronously with the registration; `setDisplayName`; system notice `<name> online · <client> <version> · <machine>`. `client`/`version`/`instance` are cleaned and capped at 100 chars |
| `reply` | `matrix.sendText` in the agent room, stops typing, `ok {held}` |
| `status` | notice `[name] text` in the control room (a leading `[name]` from the agent is dropped), `router.rememberControlMessage` |
| `ask` | `m.text` in the control room with `m.mentions.user_ids = [owner]` and an HTML pill (`mentionContent`), remembered for reply routing |
| `poll` | `polls.sendAgentPoll` (control characters removed) |
| `vote` | `polls.vote` (number answers are converted to strings) |
| `react` | `reactions.agentReact` |
| `approval_request` | `detail` must be a string if present (`error` "detail must be a string"); a `request_id` that is still pending on this link (requested, no `approval_result` sent and not cancelled; last 1000 ids per link) gets `error` "request_id already pending"; `polls.requestApproval`, then a control-room mention `[name] needs approval in its room: <title>` (remembered for reply routing; a failing mention is only logged) |
| `approval_cancel` | `polls.cancelApproval(key, request_id)`; `error` if none pending |
| `updated` | `updates.reported(key, link.version ?? "")`, system notice `<name> updated: <from> → <version>` |
| `update_failed` | `updates.reported(key, null)`, system notice `<name>: update failed: <error>` |

On close: heartbeat stopped, typing cleared, `registry.remove(link)`; the `<name> offline` notice is posted only
when that returns true (a link that was replaced by the same instance, or already swept, stays silent). Texts are
limited to 16000 characters; control characters except newline/tab are removed. Logs contain names, request types,
error classes and Matrix errcodes, never texts or error messages from modules (they may quote poll options).
