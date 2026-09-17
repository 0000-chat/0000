# Mermaid diagrams in the human view

Implementation specification: https://github.com/0000-chat/0000-full/issues/21.
Product ticket: https://github.com/0000-chat/0000/issues/49.

The planned feature renders closed Mermaid fenced blocks in the human
conversation view while preserving source text, existing message contracts,
and same-origin security protections. It includes initial messages, live
refreshes, theme changes, and readable fallback for diagrams that cannot render.

Feature tests will use only the existing renderer unit-test boundary, as
requested. Browser layout, live DOM behavior, and browser policy enforcement
are not established by that coverage. This document will record the implemented
limits and supported behavior before the PR is ready.
