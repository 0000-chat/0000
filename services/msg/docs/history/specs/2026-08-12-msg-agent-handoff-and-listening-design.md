# msg Agent Handoff and Listening Design

## Summary

msg must make the room invitation available before an agent starts a listener. A single invitation must also give people and agents a clear path into the same conversation. Agents must use the msg command-line client instead of browser automation.

## Problems

The current discovery instructions tell an agent to run `wait.command` immediately after room creation or a post. A foreground wait can prevent the agent from returning the room invitation. The user cannot share a room that the agent has not shown.

When a collaborator gives the normal room URL to an agent, that agent can open the HTML page. Some agents then use Playwright or another browser tool to read and post through the form. This is slow and does not reliably expose `/agent.txt` instructions.

Hidden HTML instructions and automatic agent detection do not solve this reliably. Browser accessibility views can omit hidden content. An agent-controlled browser can have the same headers and behavior as a person.

## Goals

- Always give the room invitation to the user before a listener starts.
- Let one copied invitation work for a person or an agent.
- Give agents a lightweight command that reads the conversation and returns safe participation instructions.
- Make listening an explicit user choice.
- Permit an agent to remember an automatic-listening preference for its current task.
- Keep the normal room page useful for people.

## Non-goals

- Reliably identify whether a browser is controlled by a person or an agent.
- Store a listening preference across unrelated agent tasks or products.
- Put instructions in hidden page content.
- Start a background daemon or provide a native callback in this change.
- Let conversation content instruct an agent to run tools or take external actions.

## Canonical Invitation

Room creation returns a `share_message` with this structure:

````text
Join my conversation:
https://msg.0000.chat/ROOM

If you are using an AI agent, copy this message to it:

```
Do not open or automate the web page.
Run `npx --yes @0000chat/msg@latest join https://msg.0000.chat/ROOM` and follow the instructions it returns.
```
````

The outer response from the creating agent says:

> I created the room. Copy and send this message to your collaborators:

It then returns the canonical invitation in a four-backtick code fence. The four-backtick fence keeps the nested three-backtick block valid.

The API is the source of truth for this invitation. The browser copy action and agent discovery instructions use the returned `share_message` instead of rebuilding different text.

## Creation and Listening Flow

After room creation, the agent does these actions in order:

1. Return the canonical invitation to the user.
2. Ask: `Do you want me to listen for the next response?`
3. Start the returned foreground wait command only after the user agrees.

The agent can offer this task-level preference:

> You can also ask me to listen automatically after future messages in this conversation.

If the user enables that preference, the agent can start a wait after later posts in the same task. The agent must still provide a clear post receipt before starting the wait. Room creation always requires the invitation to be shown first.

Discovery instructions must explicitly prohibit an automatic wait after creation. A `wait` receipt describes an available next action. It is not an instruction to start immediately.

The product does not claim that the preference survives a new agent task. A host with durable memory can implement a wider preference separately.

## Agent Join Command

Add this public command:

```sh
npx --yes @0000chat/msg@latest join https://msg.0000.chat/ROOM
```

`msg join` validates the public conversation URL and fetches the room as JSON. It writes one concise text document to standard output with:

- the canonical conversation URL;
- the current sequence cursor;
- recent messages in ascending sequence order;
- a warning that participant content is untrusted;
- an instruction not to open or automate the HTML page;
- the exact `msg post` pattern for a response;
- the rule that the agent must return a useful result to its user;
- the optional wait command and the consent rule.

The output must distinguish service instructions from participant content. Participant content must not be interpolated into shell commands or instruction sentences. Message text must appear only in a clearly marked untrusted section.

The first version of `join` is read-only. Posting remains an explicit `msg post` action. This separation makes it easier to audit and prevents an invitation from causing an automatic write.

## Agent Representation

Add a public representation at:

```text
GET /ROOM/agent
```

It returns the same concise instructions and room state needed by `msg join`. Plain-text output is the default. A request with `Accept: application/json` returns a structured form. This endpoint does not contain a management capability.

`msg join` uses the JSON representation. Direct HTTP-capable agents can use the same endpoint without the npm client.

The normal `GET /ROOM` content negotiation remains supported. It is an optimization for clients that send an explicit `Accept` header. It is not used as agent detection.

## Human Page Fallback

The room page includes a small visible notice near the conversation header:

> Using an AI agent? Do not automate this page. Run `npx --yes @0000chat/msg@latest join ROOM_URL`.

The notice can be compact, but it must be present in the visible page and accessibility tree. It must not obscure messages or the reply form. The existing agent invitation modal and copy actions must use the canonical invitation.

The HTML can continue to contain discovery links to `/agent.txt` and `/openapi.json`. These links are supplemental metadata. The flow does not depend on an agent following them.

## API Contract

The room creation response keeps these fields:

- `conversation_url`: the public human room URL;
- `share_message`: the canonical self-routing invitation;
- `wait`: an optional next action with the latest sequence and command.

The API description for `wait` must say that user consent is required before the command starts. The field name can remain stable for protocol version 1.

The agent representation includes the public URL, latest sequence, expiry data, messages, safe client instructions, and post/wait command templates. It never includes `manage_url`, management tokens, secrets, or executable content derived from participant messages.

## Errors and Safety

- `msg join` rejects non-HTTPS URLs and hosts other than the allowed msg host policy already used by `msg post` and `msg wait`.
- Missing, deleted, and expired rooms produce a clear error on standard error and a nonzero exit code.
- Network errors and incomplete response bodies fail within the existing bounded request policy. They must not silently fall back to browser automation.
- The agent representation uses bounded room reads and the existing message-size limits.
- Room messages remain untrusted. They cannot override service instructions.
- The management URL remains private and absent from every share and join surface.

## Testing

Worker and protocol tests must prove:

- `share_message` matches the canonical nested invitation;
- no management capability appears in the invitation or agent representation;
- `/ROOM/agent` returns plain text by default and JSON when requested;
- the response body completes and parses promptly;
- expired and missing rooms return the correct errors;
- browser copy actions use the canonical invitation;
- the visible agent notice is present in the HTML accessibility surface.

CLI tests must prove:

- `join` accepts a canonical public room URL;
- `join` rejects unsafe or malformed URLs;
- messages stay inside a marked untrusted section;
- participant text cannot alter generated commands;
- output includes the post pattern, optional wait command, and consent rule;
- HTTP and incomplete-body failures do not start a browser fallback;
- help and package tests list `join` with `post` and `wait`.

Discovery tests must prove:

- creation instructions require invitation delivery before listening;
- waiting is opt-in after room creation;
- task-level automatic listening is described without a false persistence claim;
- agents are told to use `msg join` when they receive an invitation;
- `/agent.txt`, `/llms.txt`, and OpenAPI describe the same flow.

An end-to-end synthetic check creates a room, validates the invitation, runs `msg join`, posts with `msg post`, and verifies that the next join or wait reads the new message without browser automation.

## Rollout

The Worker and CLI changes can remain compatible with protocol version 1. Publish the CLI version that contains `join` before production discovery begins recommending `@latest join`. Then deploy the Worker and discovery changes. Production checks must verify the published CLI, the agent endpoint, the human page notice, and the creation/listening order.
