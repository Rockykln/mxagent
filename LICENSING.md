# Licensing

Copyright © 2026 rockykln

mxagent uses two licenses so that the security-critical server stays open while anyone can connect their agents.

| Part | Paths | License |
|---|---|---|
| Daemon and admin tool | `src/`, `cli/`, `test/`, `deploy/` and everything else not listed below | [AGPL-3.0-or-later](LICENSE) |
| Client libraries | `clients/js/`, `clients/python/` | [Apache-2.0](clients/js/LICENSE) |
| MCP adapter | `adapters/mcp/` | [Apache-2.0](adapters/mcp/LICENSE) |
| Examples | `examples/` | [Apache-2.0](examples/LICENSE) |
| Protocol specification and test vectors | `docs/reference/protocol.md`, `docs/reference/protocol-test-vectors.md` | [Apache-2.0](docs/reference/LICENSE-Apache-2.0) |

## What this means

- **Running mxagent** for yourself or your organisation: no obligations.
- **Modifying the daemon and offering it to others over a network** (for example as a hosted service): you must make your modified source code available to its users under the AGPL. This keeps changes to the encryption and verification code auditable.
- **Connecting your own agent** with the client libraries, the MCP adapter or your own implementation of the protocol: your agent can use any license, including a proprietary one.

## Distribution

- **Packages and images** (npm or PyPI packages, container images, archives) must carry the license
  texts and notices of the parts they contain: `LICENSE` for the daemon and CLI, and `LICENSE` plus
  `NOTICE` of each Apache-2.0 part (`clients/js/`, `clients/python/`, `adapters/mcp/`, `examples/`).
  The client packages and the Docker image already include them; keep them in derived builds.
- **Modified daemon offered over a network:** if users interact with a modified daemon or CLI over a
  network, the AGPL requires that you offer them the complete corresponding source code of your
  version, under the AGPL.
- **Publishing a daemon image or binary** is distribution under the AGPL: provide the corresponding
  source alongside it.

## File-level license information

Source files carry `SPDX-FileCopyrightText` and `SPDX-License-Identifier` headers. Files that cannot
hold a header (JSON, Markdown, YAML, TOML, license and notice files) are covered by
[REUSE.toml](REUSE.toml), following the [REUSE](https://reuse.software) specification.

## Contributions

Contributions are accepted under the license of the part they change (inbound = outbound). See [CONTRIBUTING.md](CONTRIBUTING.md).
