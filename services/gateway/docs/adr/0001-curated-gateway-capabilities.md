---
status: accepted
---

# Curate Gateway capabilities across REST and MCP

Gateway exposes only explicitly selected business operations as Gateway Capabilities and applies Gateway-level authorization checks once in shared application behavior across REST and MCP projections. Downstream services retain their resource ACLs, while Platform establishes identity. Gateway does not automatically mirror downstream operations. This keeps the client contract deliberate and consistent while service operations evolve; operational `/health` remains a REST-only endpoint outside the business capability set.
