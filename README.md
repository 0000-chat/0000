# 0000-cloud

Purpose: future hosted-deployment coordination for the independent 0000
repositories.

Status: scaffold-only and private. `0000-cloud` contains no deployment
implementation. Cloudflare is the public ingress and normal runtime class.
Future Docker-required software uses a private provider-neutral Docker host;
DigitalOcean is an example provider only, and the host exposes no public product API.

This repository does not provision cloud resources, select an authentication
provider, or select a license. Validate with `./scripts/check`.
