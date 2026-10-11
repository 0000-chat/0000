---
repo: 0000-chat/0000
status: current
---

# Authenticated Gateway to Msg contract

This document describes the public Gateway boundary for the first
authenticated Gateway to Msg milestone. It records local implementation
behavior and the interfaces that each upstream or hosted owner must satisfy.
It does not claim that a hosted binding, route, or production deployment is
configured.

## Gateway behavior

Gateway accepts an agent credential at the canonical /mcp entry and obtains
the complete principal from Platform. The principal has kind "agent",
agentId, organizationId, and profileId. The credential, organization, and
profile are never taken from program input. The compatible paths
/mcp/profile/{profileId} and /mcp/organizations/{organizationId}/profiles/{profileId}
enforce the same binding and reject a mismatch.

Gateway stores organization-scoped profiles and explicit operation grants in
D1. Profile creation starts with an empty grant set. Discovery is sorted by
operation ID and includes only declarations in the active profile. An exact
tool call checks the current credential, profile grant, and service input
schema again. A grant revocation therefore applies to the next call without
requiring a process restart. A catalog entry never grants execution and a
missing service catalog removes that service's callable entries without
breaking Gateway liveness.

The agent-facing "use" operation runs the documented restricted JavaScript
subset implemented by Gateway's bounded interpreter. It supports literals,
arrays, null-prototype object literals, const and let bindings, return,
direct tools.<name>(object) or tools["name"](object) calls,
tools.search({query}), and tools.call({name, arguments}). The parser rejects
unsupported syntax before the first effect. Programs have no direct network,
filesystem, credential, global, loop, import, constructor, or dynamic-code
access. The boundary limits source to 32 KiB, syntax to 2,048 nodes and depth
32, host calls to eight, output to 64 KiB, and execution and each dependency
call to five seconds. The interpreter's deadline races uncooperative host
promises; an effect that has already started is not automatically reversible.

"tools.search" and "use" discovery return only profile-authorized Gateway
declarations. Msg declarations are loaded from its MCP tools/list response,
including all pages up to Gateway's bounded catalog limits. Gateway does not
infer operations from arbitrary Msg HTTP routes. The Msg adapter uses the
service binding and the target endpoint https://msg.0000.chat/mcp; it does
not forward the incoming Platform bearer credential or cookies. Gateway
identity headers sent to Msg are informational attribution only. Msg remains
the authority for Thread/resource-capability authorization.

Gateway strips unknown downstream transport metadata and returns a generic
error for downstream MCP errors. Successful operation content and structured
content remain available when the operation contract permits them, including
the private result of an authorized creation or management call. Discovery
descriptions, Gateway errors, logs, and ordinary metadata do not contain
private capability values. Gateway MCP logging is disabled explicitly.

## Platform obligation

Platform owns credential issuance, expiry, revocation, identity, and
organization authority. From Gateway's perspective, the Platform binding is a
read-only Verification entrypoint: it answers the named identity and
management-permission queries below, while Platform remains the only issuer
and lifecycle authority for credentials. The Gateway-side binding must expose
these named operations:

- inspectAgentCredential(rawCredential) receives the opaque value after
  Gateway has removed the Bearer scheme and returns either the complete agent
  principal or null.
- inspectHumanSession(rawSession, organizationId) receives only the
  platform_session cookie value and the selected organization and returns a
  human principal or null.
- canManageProfile(rawSession, organizationId, profileId) receives the same
  raw session value and returns whether that human may change the profile's
  Gateway grants.

Every agent must have a distinct credential bound by Platform to exactly one
agent, organization, and active profile. Platform must reject expired or
revoked credentials and must reflect an organization or profile rebinding on
the next verification call; stale cached membership is not sufficient. Every
returned principal must be live at the time of the call. The binding must not
return an agent bound to a different organization or profile than the
credential. Gateway treats a missing method, rejected call, malformed result,
or timeout as unavailable and fails closed. Platform's current shared
packages may use a different identity shape; the controller must reconcile
that shape to this minimal Gateway-local contract before integration.

## Msg obligation

Msg owns the agent-facing MCP manifest and must serve a standard stateless
/mcp surface through its service binding. tools/list must return complete,
validated declarations with stable tool names, descriptions, JSON input
schemas, and pagination when needed. It must include every operation Msg
declares for agents, including permitted Thread coordination, room management,
and webhook operations. Internal operator routes and arbitrary HTTP routes are
not declarations.

Msg must accept tools/call for each declared name, validate its own schemas,
and enforce the Thread or resource capability in the explicit arguments.
Gateway attribution headers are not authentication. Msg errors must not
include private capabilities in bodies that Gateway would need to relay.
Creation and management responses may return their operation-defined private
result only to the authorized caller; discovery descriptions and ordinary
metadata must remain safe.

## Cloud obligation

Cloud owns the hosted composition. A configured Worker must bind
PLATFORM_VERIFICATION, GATEWAY_DB, and the service binding named MSG, apply
the Gateway profile migration, and preserve the direct /mcp route on both the
canonical apex and standalone Gateway host. Those hosts must serve MCP POST
requests directly without a redirect; other apex paths remain with the
landing application. Cloud keeps binding credentials and route secrets outside
the public repository and supplies staging evidence separately.

## Integration acceptance

The controller can assign the owners independently when these local checks
pass: a verified profile lists only its granted declarations; an exact
ungranted name is denied; a revoked grant fails on the next direct and use
call; a downstream resource denial is returned as a generic tool failure; and
the dependent create, read, and post Thread operations execute through the
real Gateway entry and real Msg Worker. The full hosted milestone remains
pending until Platform, Msg, and Cloud exercise their real integrations.
