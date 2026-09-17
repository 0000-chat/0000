# 0000-cloud

This directory carries the hosted-deployment coordination scaffold for the
independent 0000 repositories inside the public `0000` monorepo. It is
coordinated by `0000-full` and contains no application code.

Status: scaffold-only. Cloudflare is the public ingress and normal runtime
class. Future Docker-required software uses a private provider-neutral Docker
host; DigitalOcean is an example provider only, and the host exposes no public
product API.

This scaffold does not provision cloud resources, select an authentication
provider, or select a license. Run `bun run check:application` for its
metadata, lint, and formatting checks. Run monorepo workspace checks from the
repository root.
