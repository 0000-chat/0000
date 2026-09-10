# 0000-cloud

This private repository is the future coordination point for hosted deployment
of the independent 0000 repositories. It is coordinated by `0000-full`, not a
place for application code in this scaffold.

Cloudflare is the public ingress and normal runtime class. Future software that
requires Docker runs on a private provider-neutral Docker host (DigitalOcean
is only an example); that host does not expose a public product API. This
repository coordinates hosted deployment later and currently contains no
deployment implementation, package manifest, generated dependency tree,
database, API, secret, or license.

Run `./scripts/check`; direct commits on `main` are blocked after bootstrap.

