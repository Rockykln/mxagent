# Documentation

The docs are split in two parts:

- **Guides** (`docs/guide/`) are for people who want to run the bridge and connect agents.
- **Reference** (`docs/reference/`) is for people who implement a client, change the daemon or
  review security. Exact formats, crypto parameters, module APIs.

## What to read for your goal

| Goal | Read |
|---|---|
| Set up the bridge and connect a first agent | [guide/getting-started.md](guide/getting-started.md) |
| Look up a setting | [guide/configuration.md](guide/configuration.md) |
| Learn what you can do from your Matrix client | [guide/commands.md](guide/commands.md) |
| Understand what is protected and what is not | [guide/security.md](guide/security.md) |
| Find a quick answer | [guide/faq.md](guide/faq.md) |
| Run it as a service (systemd, Docker) | [../deploy/README.md](../deploy/README.md) |
| Write an agent in JavaScript or TypeScript | [../clients/js/README.md](../clients/js/README.md) |
| Write an agent in Python | [../clients/python/README.md](../clients/python/README.md) |
| Connect an agent that runs in an MCP host | [../adapters/mcp/README.md](../adapters/mcp/README.md) |
| See working example agents | [../examples/README.md](../examples/README.md) |
| Implement the protocol in another language | [reference/protocol.md](reference/protocol.md), [reference/protocol-test-vectors.md](reference/protocol-test-vectors.md) |
| Understand the code layout | [reference/architecture.md](reference/architecture.md) |
| Work on a daemon module | [reference/internals.md](reference/internals.md) |
| See protocol and API changes between versions | [reference/changelog-technical.md](reference/changelog-technical.md) |
| Contribute | [../CONTRIBUTING.md](../CONTRIBUTING.md), [../AGENTS.md](../AGENTS.md) |
| Report a vulnerability | [../SECURITY.md](../SECURITY.md) |

## Guides

| File | Content |
|---|---|
| [guide/getting-started.md](guide/getting-started.md) | install, configure, log in, start once, anchor and verify the bot (`cross-sign`), connect local and remote agents |
| [guide/configuration.md](guide/configuration.md) | config file location and format, all `MXA_*` settings, agent settings, state directory |
| [guide/commands.md](guide/commands.md) | rooms, control-room commands, reply routing, approvals, delivery reactions, updates, polls |
| [guide/security.md](guide/security.md) | who can see and send what, secrets to protect, limits, residual risks, compromised host |
| [guide/faq.md](guide/faq.md) | homeserver support, design choices, offline agents, naming |

## Reference

| File | Content |
|---|---|
| [reference/protocol.md](reference/protocol.md) | agent wire protocol: transports, handshake, message types, delivery semantics (the contract) |
| [reference/protocol-test-vectors.md](reference/protocol-test-vectors.md) | fixed inputs and outputs for the WebSocket handshake |
| [reference/architecture.md](reference/architecture.md) | components, module list with file paths and responsibilities |
| [reference/internals.md](reference/internals.md) | exported API and behaviour of the daemon modules in `src/daemon/` |
| [reference/changelog-technical.md](reference/changelog-technical.md) | changes marked by impact on protocol and agents |

If a guide and the reference disagree, the reference wins; `reference/protocol.md` is the
authoritative wire contract.
