# Contributing

See [AGENTS.md](AGENTS.md) for the repository map and [docs/README.md](docs/README.md) for the docs index.

## Setup

```sh
npm ci
npm run check   # tsc --noEmit
npm test        # node --test "test/**/*.test.{ts,mjs,js}"
(cd clients/python && python3 -m unittest discover -s tests)   # Python SDK, needs cryptography
```

Node.js ≥ 22.18. The code runs via Node's type stripping: use only erasable TypeScript syntax
(no `enum`, `namespace`, parameter properties or decorators), import local files with the `.ts`
extension and use `import type` for types.

## Guidelines

- Keep changes focused; one topic per pull request.
- Add or update tests in `test/` (no network access in tests).
- [docs/reference/protocol.md](docs/reference/protocol.md) is the wire contract. Protocol changes need a discussion first and must
  update `src/protocol/messages.ts` and all clients together.
- Never log message bodies, tokens or secrets. Compare secrets in constant time.
- Comments only where the code is not self-explanatory. English everywhere.
- Update the docs when behavior or configuration changes.
- New source files start with the SPDX header of their directory (see [AGENTS.md](AGENTS.md#licensing)).

## Reporting

Bugs and feature requests: open an issue with steps to reproduce and your homeserver/client.
Security issues: see [SECURITY.md](SECURITY.md).

## Licensing of contributions

By contributing you agree that your contribution is licensed under the license of the part you change
(AGPL-3.0-or-later for the daemon and CLI, Apache-2.0 for the client libraries, MCP adapter, examples and
protocol specification). See [LICENSING.md](LICENSING.md).
