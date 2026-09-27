# Legacy Gateway deployment

The former public `main` workflow checked out the repository, ran the public
quality gates, invoked Wrangler with a Cloudflare token, and smoke-tested
`gateway.0000.chat`. That path was an observed exception to the public/Cloud
boundary and is retained in Git history for auditability.

As of the public release scaffold, `.github/workflows/deploy-gateway.yml` is a
disabled manual-only placeholder. It does not contain deployment credentials or
an invocation of Wrangler and cannot deploy from a public `main` merge. Private
Cloud must provide and verify the replacement staging/promotion path before any
runtime deployment is reconsidered. Before cutover, revoke the former
repository-level deployment credential as well: historical workflow runs retain
their original workflow definition and can still be rerun even after the new
workflow file is disabled.
