# AGENTS.md

Instructions for coding agents and automated tools working on this repository.
Human contributors: see [CONTRIBUTING.md](CONTRIBUTING.md).

## Project

mxagent lets one person control AI agents from an end-to-end encrypted Matrix space.
A daemon logs in as a single bot account, gives every agent its own room and accepts messages only
from the configured owner's verified sessions. Agents connect over a Unix socket or an encrypted
WebSocket using a small NDJSON protocol.

## Repository map

| Path | Content |
|---|---|
| `src/protocol/messages.ts` | wire types of the agent protocol (mirrors `docs/reference/protocol.md`) |
| `src/protocol/secure.ts` | WebSocket handshake and encrypted framing (pure functions, no I/O) |
| `src/daemon/` | bridge daemon; entry point `index.ts`, one file per module (see `docs/reference/architecture.md`), transports in `transport/` |
| `cli/mxagentctl.ts`, `cli/commands/` | admin CLI, run as `node cli/mxagentctl.ts <command>` or `npm run ctl -- <command>` (no installed binary) |
| `clients/js/` | JavaScript SDK, zero dependencies (`index.mjs`, `index.d.ts`, `secure.mjs`, `lines.mjs`) |
| `clients/python/` | Python SDK (`src/mxagent/`, tests in `tests/`) |
| `adapters/mcp/server.mjs` | MCP server exposing the protocol as tools plus an inbox (`npm run mcp -- --name <agent>`) |
| `examples/` | small example agents (JS, Python) and `healthcheck.sh` |
| `deploy/` | systemd units, Dockerfile, compose file, deployment notes |
| `test/` | Node unit tests (`*.test.ts`, `*.test.mjs`), no network |
| `docs/guide/` | user guides |
| `docs/reference/` | protocol, test vectors, architecture, daemon internals, technical changelog |
| `docs/README.md` | docs index: what to read for which goal |

## Commands

Run from the repository root unless noted. Requires Node.js >= 22.18.

| Task | Command |
|---|---|
| install dependencies | `npm ci` (do not use `--ignore-scripts`; the crypto library downloads a native binary) |
| type check | `npx tsc --noEmit -p .` (same as `npm run check`) |
| Node tests | `npm test` |
| Python tests | `cd clients/python && python3 -m unittest discover -s tests -v` (needs `cryptography`) |
| Python end-to-end tests | part of `npm test` (`test/e2e.test.ts`); skipped without Python + `cryptography` + `websockets` unless `MXA_REQUIRE_PY_E2E=1` |
| run the daemon | `npm start` (= `node src/daemon/index.ts`) |

The type check and both test suites must pass before a change is complete. Tests must not use the network; loopback
sockets are fine.

## Licensing

Two licenses, see `LICENSING.md`: daemon and CLI (`src/`, `cli/`, `test/`, `deploy/`) are
AGPL-3.0-or-later; `clients/`, `adapters/`, `examples/` and the protocol spec are Apache-2.0.
Every source file starts with `SPDX-FileCopyrightText: 2026 rockykln` and an `SPDX-License-Identifier`
line matching its directory; keep both on new files. Files without a header (JSON, Markdown, YAML,
TOML, license files) are covered by `REUSE.toml`; a new Apache-2.0 file outside `clients/`,
`adapters/` and `examples/` needs an entry there.

## Coding rules

- **TypeScript runs via Node type stripping, no build step.** Use only erasable syntax: no `enum`,
  no `namespace`, no constructor parameter properties, no decorators.
- ESM only. Import local files with the `.ts` extension. Use `import type` for type-only imports.
- `strict` mode must pass.
- Daemon modules take their dependencies explicitly (constructor or function arguments). No
  module-level singletons. Signatures are documented in `docs/reference/internals.md`; update it
  when you change an exported API.
- **Never log** message bodies, captions, poll content, attachment data, access tokens, passwords,
  machine secrets or recovery keys. Logging ids, names, sizes and counts is fine.
- Compare secrets in constant time. Validate all input from the network and from Matrix events.
- Never treat a Matrix event as owner input unless it was decrypted by the sync loop (not fetched,
  room key not forwarded, `mxa_sender.userId` equal to the sender) and passed `OwnerTrust.check`
  with `event.sender === config.owner`. Reactions, even verified ones, must never drive decisions;
  reply relations (`m.relates_to`) are unencrypted and may only point to messages the daemon sent
  in the current run.
- English for code, comments, messages and docs. Comments only where the code is not obvious.
- No absolute home paths, real hostnames or personal data in code, tests or docs. Use
  `example.org`, `matrix.example.org` and `$XDG_*` variables.

## Protocol changes

`docs/reference/protocol.md` is the wire contract. A change to it must update, in the same
change:

1. `docs/reference/protocol.md`
2. `src/protocol/messages.ts` (and `src/protocol/secure.ts` for handshake/framing)
3. the JavaScript SDK: `clients/js/index.mjs`, `clients/js/index.d.ts`, `clients/js/secure.mjs`
4. the Python SDK: `clients/python/src/mxagent/`
5. `adapters/mcp/server.mjs` if the change adds or alters an agent request
6. test vectors when the handshake or framing changes: `docs/reference/protocol-test-vectors.md`,
   `test/secure.test.ts`, `clients/python/tests/test_secure.py`
7. `docs/reference/changelog-technical.md`, marked **[protocol]**

## Where to start

| Task | Start with |
|---|---|
| change a config key | `src/daemon/config.ts`, then `docs/guide/configuration.md` and `docs/reference/internals.md` |
| change owner verification | `src/daemon/trust.ts`, `test/trust.test.ts`, `docs/guide/security.md` |
| change room creation | `src/daemon/rooms.ts` |
| change agent naming or reconnect rules | `src/daemon/registry.ts`, `test/registry.test.ts` |
| change Matrix login, sending or event hooks | `src/daemon/matrix.ts` |
| change message routing or control-room commands | `src/daemon/router.ts`, `src/daemon/commands.ts`, `test/router.test.ts`, `test/commands.test.ts` |
| change agent requests (daemon side) | `src/daemon/agent-link.ts` |
| change an admin command | `cli/commands/`, `test/mxagentctl.test.ts`, `docs/guide/` |
| add a protocol message | see [Protocol changes](#protocol-changes) |
| change the handshake or encryption | `src/protocol/secure.ts`, `clients/js/secure.mjs`, `clients/python/src/mxagent/secure.py`, test vectors |
| change an SDK | `clients/js/` or `clients/python/`, plus its README |
| change the MCP adapter | `adapters/mcp/server.mjs`, `test/mcp-adapter.test.mjs`, `adapters/mcp/README.md` |
| change deployment | `deploy/` and `deploy/README.md` |
| user-facing docs | `docs/guide/`; keep deep details in `docs/reference/` and link to them |
