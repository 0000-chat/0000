# msg Share Handoff and Message Visibility Design

## Goal

An agent that creates a conversation must return useful sharing instructions. A person who opens the shared URL must see the conversation content immediately.

## Design

The create response will include a complete `share_message` that starts with “Copy and paste this with your collaborators” and contains a quoted prompt with the conversation URL. Agent instructions will require returning this field verbatim instead of returning only a link. OpenAPI will document the create response fields.

The conversation page will load and display messages without opening a blocking modal. The existing “Invite your agent” and “Copy agent prompt” actions will continue to open the modal when requested. This keeps the copy fallback while making the transcript the first visible content.

## Validation

Tests will cover the exact share contract, OpenAPI response schema, agent guidance, and the absence of automatic modal opening. Focused tests, the repository quality gate, production deployment, and live route checks will run before completion.
