# Platform task entry

Read [README.md](README.md) for Platform's scope, ownership boundaries and
ecosystem relationships. For authentication work, then read
[AUTH_FIRST_SPEC.md](AUTH_FIRST_SPEC.md), including its status and acceptance
gates. Proposed mechanisms in the spec are not claims of implemented behavior.

Platform owns shared identity and credential issuance. Services own resource
authorization. Do not introduce another service-local auth system, require
Spaces for service access, or make Platform bootstrap depend on Database.

This directory belongs to the 0000 monorepo, not a separate Git repository.
Inspect current repository instructions, status and ongoing migrations before
editing. Preserve other tasks' staged and unstaged changes. Shared contracts
and Platform client changes belong in the monorepo's corresponding packages.

Keep the README status and auth acceptance gates accurate as work lands.
Never describe a scaffold check as a working authentication integration test.
