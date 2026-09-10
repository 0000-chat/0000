# 0000-platform

Purpose: shared platform boundary and future authentication adapters.

Status: scaffold-only. This repository intentionally contains no application
code or package/deployment implementation. Standalone public use does not
require hosted platform authentication; a future adapter can connect the
boundary to a provider selected later.

Expected hosting is Cloudflare as the public ingress and normal runtime class.
The scaffold does not provision Cloudflare resources and does not select a
license.

Validate with `./scripts/check`.

