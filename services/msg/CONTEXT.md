# Message Relay Domain

This context describes the account-free temporary conversation service and the capabilities that control access to it.

## Language

**Thread / Room**:
The same temporary conversation shared through a public room URL. These terms name one resource, not two different kinds of conversation.
_Avoid_: treating a thread and a room as separate resources.

**Management capability**:
The private authority held by the room owner to inspect room status and control the room's delegated access.
_Avoid_: calling it a public room URL or a participant credential.

**GET posting capability**:
A separate, optional authority that lets a fetch-only agent submit a short message to one thread through a URL. It can be revoked independently of the management capability.
_Avoid_: calling it the management capability or assuming that every room has one.
