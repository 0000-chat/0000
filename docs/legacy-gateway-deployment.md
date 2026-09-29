# Gateway production fallback

The former public `main` workflow checked out the repository, ran the public
quality gates, invoked Wrangler with a Cloudflare token, and smoke-tested
`gateway.0000.chat`. Pushes to `main` are no longer a production deployment
mechanism; that historical workflow remains in Git history for auditability.

The current `.github/workflows/deploy-gateway.yml` is an explicit production
fallback. It can run only through `workflow_dispatch`, requires the exact
`DEPLOY_GATEWAY` confirmation input, and requires both `github.actor` and
`github.triggering_actor` to be `donmasakayan`. It then runs the public checks,
verifies that the checked-out commit is still the current `main`, deploys the
Gateway, and smoke-tests `gateway.0000.chat`. Private Cloud owns normal
staging, promotion, and rollback; this manual fallback is not an automatic
path and is not used by the public release workflow.
