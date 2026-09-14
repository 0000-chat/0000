# Share one messaging boundary across API and MCP

Communicator exposes one authenticated API and one remote MCP interface over the same messaging operations and permission grants, with ChatGPT plugin packages connecting through MCP. This keeps agent clients consistent while replacing computer-use-specific paths; it does not choose the credential model or named-Bot isolation behavior.
