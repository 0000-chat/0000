---
repo: 0000-chat/0000
status: draft
---

# Reconcile Platform with standalone MCP and Gateway access

The approved Platform MVP provides one identity and credential authority for a
selected product composition. A self-hosted standalone service uses its own
Platform instance. Its direct API, and any MCP surface it publishes, must use
the same registered service audience and shared principal verification path.
Neither native MCP nor Gateway introduces a service-local login or issuer.

Gateway is an optional common entry for agents and app/API clients. It owns
Access Profile and Connection grants and catalogs tools that services publish.
Platform supplies a current principal with a stable credential ID; Gateway
binds that credential to one organization-owned profile and checks its grants.
The resource-owning service still checks its own permissions. A Gateway bearer
cannot be forwarded unchanged to another service audience.

Before a Gateway integration is reported as working, settle and test the
downstream proof contract: how Gateway presents the caller's verifiable
Platform authority to a target service under that service's audience, how
revocation reaches the next tool call, and how a service-owned tool manifest
maps to direct and Gateway calls without duplicating authorization rules.
Exercise a denied exact tool invocation, a wrong audience, a removed profile
grant, and a resource denial at the target service. These are Gateway
integration gates, not retrospective claims of the Platform MVP.

Keep generic self-hosting configuration and policy schemas public. Hosted
provider credentials, fleet provisioning, namespace allocations and managed
deployment inputs belong to private Cloud operations. The public product must
build and run without Cloud. Before closing the Platform deployment ticket,
reconcile any proposed managed policy files placed under the public
`services/cloud` scaffold with that ownership boundary; retain only generic
examples there.

The older MVP branch predates the public documentation frontmatter policy.
Before publishing it, reconcile every tracked Platform Markdown file with the
required repository/status metadata and classify historical proof reports as
records rather than maintained instructions. The archived ticket breakdown is
not a live task board. Refresh the PR and issue status after the final clean
setup proof and current checks, rather than copying their older checkpoint
claims into the maintained service README.

This plan is closed when the maintained Platform scope and setup guides state
these boundaries, the managed configuration is placed with its actual owner,
and the separate Gateway integration contract has executable evidence. It does
not add an MCP server to Platform or make Gateway a prerequisite for direct
service access.
