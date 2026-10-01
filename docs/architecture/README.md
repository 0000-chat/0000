---
repo: 0000-chat/0000
status: current
---

# Service architecture map

Each service owns its product scope, architecture, and interfaces. Cross-service
decisions belong in this directory and link to those owners. Keep shared
contracts with their owner instead of copying them into each service.

| Service | Product role | Documentation |
| --- | --- | --- |
| Platform | Shared identity and control plane | [Platform docs](../../services/platform/docs/README.md) |
| Gateway | Common entry and request adaptation | [Gateway docs](../../services/gateway/docs/README.md) |
| Database | Durable data storage | [Database docs](../../services/database/docs/README.md) |
| Streams | Ordered event and record streams | [Streams docs](../../services/streams/docs/README.md) |
| Brain | Evidence-backed knowledge | [Brain docs](../../services/brain/docs/README.md) |
| Communicator | Communication channels and bridges | [Communicator docs](../../services/communicator/docs/README.md) |
| Msg | Temporary Threads | [Msg README](../../services/msg/README.md) |

The [workspace README](../../README.md) describes the monorepo. Each service
README states its role and maturity. Follow that service's documentation for
implementation details. A proposal or migration record alone does not establish
current behavior.

When a change crosses services, update the contract owner and affected service
indexes together. Record an accepted cross-service decision in
`decisions/NNNN-topic.md`. Keep temporary work in `plans/YYYY-MM-DD-topic.md`,
then archive or supersede the plan and link to the maintained result.
