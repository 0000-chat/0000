# 0000-cloud

This directory carries the hosted-deployment coordination scaffold for the
independent 0000 repositories inside the public `0000` monorepo. It is
coordinated by `0000-full` and contains no application code.

The proposed managed msg rate-limit input is kept under
[`provisioning/platform-auth`](provisioning/platform-auth/README.md). Cloud
owns those deployment-time values while msg owns the public policy parser and
binding builders; the input does not add a runtime request to Cloud.

Status: scaffold-only. Cloudflare is the public ingress and normal runtime
class. Future Docker-required software uses a private provider-neutral Docker
host; DigitalOcean is an example provider only, and the host exposes no public
product API.

This scaffold does not provision cloud resources, select an authentication
provider, or select a license. Run `bun run check:application` for its
metadata, lint, and formatting checks. Run monorepo workspace checks from the
repository root.
