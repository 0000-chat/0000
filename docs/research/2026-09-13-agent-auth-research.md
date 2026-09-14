# Agent authentication and credential model research

Assessment date: 2026-09-13. This note answers the remaining credential and
agent-consumer question for the agreed shared API/MCP boundary. It is based on
the current [product alignment](../product-alignment.md), the read-only [built
versus agreed scope assessment](2026-09-13-built-vs-agreed-scope.md), and
current primary documentation. It does not select an authentication vendor or
authorize live client setup.

## Recommended direction

Communicator should use a standards-based OAuth connection for each client
installation, then apply its own durable account/chat grants to the authenticated
request. The transport credential and the named agent are different objects. A
credential proves which user/client connection is calling; a named agent is a
logical workflow to which the administrator may grant access. This distinction
fits the existing OIDC `iss`/`sub` verifier, optional `jti` handling, and
append-only token revocation in the control directory, while preserving one
authorization resolver for the API and MCP surfaces.

The local scope already requires one authenticated API and one remote MCP
interface over the same operations and grants, with administrator-only grant
changes. The gap assessment records that OIDC verification and directory
authorization exist, but remote MCP, connected-account/chat grants, and the
administrator grant workflow do not. See [ADR-0001](../adr/0001-shared-api-mcp-boundary.md),
[product alignment Q16/Q38/Q42](../product-alignment.md#L80), and the [gap
assessment](2026-09-13-built-vs-agreed-scope.md#L64).

## Current primary-source constraints

OpenAI’s plugin authentication documentation says ChatGPT performs an OAuth
authorization-code flow with PKCE using `S256`, sends the `resource` parameter
through authorization and token requests, and attaches the resulting bearer
access token to later MCP requests. The resource server must verify signature,
issuer, audience or resource, expiry, and scopes on every request. The same
documentation describes Client ID Metadata Documents (CIMD) as the preferred
registration path when supported, with Dynamic Client Registration as a
fallback. It also explicitly says ChatGPT does not support machine-to-machine
grants such as client credentials, service accounts, or JWT bearer assertions,
and cannot present a custom API key. [OpenAI plugin authentication](https://developers.openai.com/plugins/build/auth)

ChatGPT Work adds a separate policy layer. Plugins can be available in Chat and
Work across web, desktop, and mobile, but plugin availability does not grant
access to the connected service. The authenticated individual, shared, or
agent-owned account and its source-system permissions still control access.
Communicator must therefore treat ChatGPT workspace/plugin approval and its own
administrator grant as separate gates. [ChatGPT Work overview](https://learn.chatgpt.com/docs/enterprise/chatgpt-work-overview),
[plugin controls](https://learn.chatgpt.com/docs/enterprise/apps-and-connectors)

The reviewed 2025-11-25 MCP authorization specification requires an HTTP MCP server to act
as an OAuth resource server, publish protected-resource metadata, and identify
its authorization server. Clients send bearer tokens in the `Authorization`
header on every request and never in query parameters. Tokens must be issued
for the MCP server as their intended audience; invalid or expired tokens are
401, while insufficient scopes are 403. The spec also requires resource
indicators and forbids accepting or forwarding tokens intended for another
resource. Its scope challenge flow supports incremental authorization, but a
scope challenge cannot replace Communicator’s own account/chat ACL. [MCP
authorization specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)

xAI’s connector documentation says a custom MCP server must be publicly
reachable, and the server owner controls authentication and access. Its Grok
Bot security documentation is the decisive identity constraint: a Bot has no
identity or credentials of its own, acts as the signed-in member, and cannot
have more access than that member. Connector tokens stay on the provider
backend. Multiple Bots under one user share the computer and available
connections. A separately isolated credential set requires a separate user.
[xAI custom connectors](https://docs.x.ai/grok/connectors), [Grok Bot
security](https://docs.x.ai/grok-bot/security), [xAI identity and access](https://docs.x.ai/grok-bot/identity-and-access)

## Options and trade-offs

| Option | Benefit | Cost or incompatibility | Recommendation |
| --- | --- | --- | --- |
| One static API/bearer token | Simple for a preconfigured first-party client | Does not satisfy ChatGPT Work’s documented user authorization flow or establish its OAuth installation semantics; it can still be audience-bound and server-revocable if designed that way | Not recommended for ChatGPT Work/Grok |
| Per-named-agent machine credentials | Clear isolation and audit labels | ChatGPT does not support machine-to-machine grants; Grok Bot does not expose a Bot identity | Keep only as a later first-party-client option |
| OAuth connection plus local grants | Interoperates with MCP, supports consent, expiry, reauthorization, and revocation; preserves provider-neutral deployment | Requires discovery endpoints, an authorization-code flow, and a token/grant data model | Recommended |
| Vendor-specific identity product | May shorten setup | Couples the product to a vendor before a requirement exists and does not solve named-Bot semantics | Keep vendor choice open |

## Proposed design choices

1. **Credential unit.** Model each OAuth link as a `client_installation` or
   `credential_grant`, separate from `principals`, `identities`, and connected
   messaging accounts. Keep the normalized external subject (`issuer`, `sub`)
   on the principal and associate each installation with the OAuth client ID,
   canonical resource/audience, creation/revocation state, and token `jti`
   digest when token-level denylisting is needed. Store no raw access or refresh
   token in the control directory. Keep the current append-only
   `revoked_tokens` pattern for token-level denylisting, and add installation
   revocation that invalidates all later requests derived from that installation.

2. **API and MCP resource policy.** Enforce the MCP resource indicator and reject
   a token issued for another resource. Separate canonical resource identifiers
   for the API and MCP endpoints are a design choice, not an MCP requirement;
   either separate resources or one deliberate shared resource can be valid when
   the issuer and both request paths verify the intended audience consistently.
   A token minted for one resource must not be accepted by another merely
   because the subject is the same, and neither surface may forward its inbound
   token to a provider. Both transports call the same post-verification
   authorization resolver, which returns the principal, installation, tenant,
   logical agent (when selected), connected-account grants, and operation scopes.

3. **Named-agent identity.** Retain the existing app-facing agent identity
   concept as a durable logical record. It is selected by an administrator and
   appears in audit and grant records; a caller-supplied name or tool argument
   is not proof of identity. The effective permission is the intersection of
   OAuth scopes and a local grant keyed to installation plus agent identity,
   connected account, and either all current/future chats or an explicit chat
   set. Newly connected accounts remain ungranted until the administrator acts.

4. **Shared Grok Bot behavior — USER DECISION REQUIRED.** The xAI documentation
   establishes that several Bots can share one connector installation and that a
   Bot has no independent identity. The safe implementation default would give
   every Bot on that installation the same Communicator grant, record the
   authenticated member/installation as the authoritative actor, and keep a
   named Bot as optional context only. That materially changes the product
   meaning of “the agent that created this subscription” and does not provide
   per-Bot ownership. The user must choose between accepting connection-wide
   grants/ownership for shared clients or requiring separate external users or
   credential connections for per-agent isolation. Do not treat either choice as
   settled by this research.

5. **Revocation.** Every API/MCP request rechecks active
   principal, installation, membership, account/chat grant, and token revocation.
   Dispatch, queued sends, file reads, and webhook delivery recheck the same
   authorization immediately before acting. This is the proposed enforcement
   behavior for the agreed revocation requirement.

6. **Webhook ownership — USER DECISION REQUIRED.** The product alignment says
   agents manage subscriptions they created, while the xAI identity model may
   provide only a shared connection identity. A subscription can record its
   creator installation and optional logical agent, but Communicator cannot prove
   which shared Grok Bot initiated it. The user must decide whether shared
   clients receive connection-wide subscription ownership, whether Grok Bot
   agents may manage subscriptions at all until separate credentials exist, or
   whether the product requires a stronger client identity before enabling this
   operation. The administrator/owner-all-access rule remains compatible with
   each option.

7. **MCP protocol surface.** Publish protected-resource metadata and OAuth
   authorization-server metadata, return `WWW-Authenticate` with the required
   resource metadata and operation scopes, and return 401/403 according to the
   MCP rules. Treat OAuth scope upgrades as transport consent only: they never
   expand the local administrator grant. Keep the identity-provider choice open
   until the implementation phase has a concrete deployment requirement.

## Remaining choices and bounded proof

The primary sources establish the transport facts: ChatGPT Work uses an OAuth
user flow for MCP, the reviewed MCP version requires resource-bound bearer-token
validation, and xAI does not expose a separate Grok Bot credential. The local
repository establishes the reusable OIDC `iss`/`sub`/`jti` and revocation seams.

Consequential choices remain open: connection-wide versus per-named-agent
ownership for shared clients; whether API and MCP use one canonical resource or
separate resources; whether any first-party client may use a pre-provisioned
static credential; and which authorization server, if any, hosts the OAuth
flow. The remaining bounded proof is to verify the actual ChatGPT Work flow and
supported Grok web/mobile/Bot connector surfaces before promising client
wake-up behavior. This note recommends a direction and records the trade-offs;
it does not resolve those product choices or authorize live messages.

## Sources

- [OpenAI plugin authentication](https://developers.openai.com/plugins/build/auth)
- [ChatGPT Work overview](https://learn.chatgpt.com/docs/enterprise/chatgpt-work-overview)
- [ChatGPT plugin controls](https://learn.chatgpt.com/docs/enterprise/apps-and-connectors)
- [Reviewed MCP authorization specification, 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
- [xAI custom MCP connectors](https://docs.x.ai/grok/connectors)
- [Grok Bot security](https://docs.x.ai/grok-bot/security)
- [xAI identity and access](https://docs.x.ai/grok-bot/identity-and-access)
- [xAI create and manage Bots](https://docs.x.ai/grok-bot/bots)
