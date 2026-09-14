# Communicator

Communicator is an agent-first service that connects AI agents to the user's own conversations across messaging providers for reading and replying, with a secondary UI for administration and debugging.

## Language

**Waiting for connection**:
A saved outgoing reply waiting for its messaging connection to become available before it can be sent.
_Avoid_: Failed, sent

**Delivery uncertain**:
An outgoing reply whose acceptance by the messaging provider cannot yet be confirmed or ruled out.
_Avoid_: Failed, delivered

**Outgoing message**:
A message authored by the user or by an authorized agent on the user's behalf, intended for dispatch through a messaging provider; it is not inherently sent.

**Incoming message**:
A message from another participant received through a connected messaging provider.

**Chat**:
A separate conversation belonging to a messaging provider, including group conversations; chats are not automatically merged.

**Webhook subscription**:
An independently managed request to deliver selected message events to one webhook destination, with its own delivery status and retry state.
