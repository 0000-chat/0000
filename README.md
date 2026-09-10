# 0000-gateway

Purpose: ingress and protocol-translation boundary.

Status: scaffold-only. The gateway may compose the Executor SDK in a future
reviewed implementation, but this scaffold neither forks nor vendors Executor.
It contains no application code or package/deployment implementation.

Standalone public use does not require hosted platform authentication. Cloudflare
is the public ingress and normal runtime class; no resources are provisioned by
this repository. No license is selected.

Validate with `./scripts/check`.

