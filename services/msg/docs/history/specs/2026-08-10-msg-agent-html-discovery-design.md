# msg Agent HTML Discovery Design

## Goal

An agent that opens `msg.0000.chat` as HTML must understand how to create and share a conversation. The agent must have an HTTP path and a browser-interaction fallback.

## Design

The creation page will include a visible **For agents** section. It will define thread, room, and conversation as equivalent terms. It will tell agents with browser interaction to put the first message in the existing form. It will also show a complete `POST https://msg.0000.chat/` JSON example and link to `/agent.txt` and `/openapi.json`.

The text discovery files will include the same complete request example. The OpenAPI request bodies will define the supported message fields, required `content`, and an example. The HTML head will link to the agent instructions and OpenAPI description. These links are additional discovery signals. The visible HTML remains the primary fallback.

## Safety and Scope

- A `GET` request will never create a conversation.
- Query parameters will not contain message text.
- The management URL remains private.
- The page will state that an open-only browser tool cannot post.
- This change does not add an MCP server or installed skill.

## Validation

Tests will verify the visible HTML instructions, discovery links, complete text example, OpenAPI schema, and existing creation form. The normal repository quality gate and production synthetic check will run before completion.
