# 0000-brain

0000-brain is an LLM-supported wiki and knowledge service for people and
agents. It derives structured knowledge from permitted sources while
preserving evidence and source traceability, including changes,
contradictions, and corrections.

Status: scaffold-only. No model integration, application code, API, or
deployment implementation is selected here. A self-hosted deployment does
not require a hosted 0000 account; Brain uses the operator's Platform for
common identity and authorization.

Cloudflare is the public ingress and normal runtime class. No resources are
provisioned by this service, and no license is selected.

Run ./scripts/check for the service validation. The outer monorepo check
validates the @0000/brain workspace wrapper.
