# Security policy

## Reporting a vulnerability

Please do not open public issues for security problems.

Send a report to **security@rockykln.com**.

Include:

- affected version or commit,
- description and impact,
- steps to reproduce or a proof of concept,
- whether the issue is already public.

We aim to acknowledge reports within 7 days. Please allow time for a fix before
disclosure; we will coordinate a disclosure date with you and credit you unless you prefer
otherwise.

## Scope

In scope: the daemon, `mxagentctl`, the protocol and handshake, the SDKs, the MCP adapter and the
deployment files in this repository.

Out of scope: vulnerabilities in Matrix homeservers, clients or third-party dependencies (report
those upstream), and issues that require a compromised daemon host (see
[docs/guide/security.md](docs/guide/security.md)).

## Supported versions

Only the latest release receives security fixes.
