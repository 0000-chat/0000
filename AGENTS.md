# 0000-gateway

This repository is the scaffold for the gateway boundary. It remains an
independent repository coordinated by `0000-full`.

The gateway may compose the Executor SDK later. This scaffold neither forks
nor vendors Executor and contains no application implementation, package
manifest, generated dependency tree, database, API, deployment configuration,
secret, or license.

Standalone public components do not require hosted platform authentication.
Cloudflare is the public ingress and normal runtime class. Run
`./scripts/check`; direct commits on `main` are blocked after bootstrap.

