# Security

Agent Fabric is local-first infrastructure. Treat daemon sockets, SQLite files, task packets, cost metadata, and worker logs as sensitive unless you have reviewed them.

## Supported Scope

This repository is pre-1.0. Security fixes are accepted for the current main branch.

## Reporting

Please open a private security advisory on GitHub if available. If not, open an issue with a minimal, non-sensitive reproduction and omit credentials, tokens, private logs, or proprietary project content.

## Operator Guidance

- Do not commit `.env` files, provider keys, shell history, browser profiles, cookies, SQLite databases, sockets, or generated worker sandboxes.
- Keep HTTP endpoints bound to localhost unless you have added your own authentication and network controls.
- Use sandboxed workspaces for untrusted worker lanes.
- Review worker-generated patches before applying them.
- Use strict sensitive-context scanning before sending task packets to remote model providers.
