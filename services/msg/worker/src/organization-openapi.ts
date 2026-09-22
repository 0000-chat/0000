const capability = (name: string) => ({ name, in: "path", required: true, schema: { type: "string", pattern: "^[A-Za-z0-9_-]{43}$" } });
const nameBody = { required: true, content: { "application/json": { schema: { type: "object", required: ["name"], properties: { name: { type: "string", minLength: 1, maxLength: 80 } } } } } };
const chatBody = { required: true, content: { "application/json": { schema: { type: "object", required: ["conversation_url"], properties: { conversation_url: { type: "string", format: "uri", description: "Canonical conversation URL on this service, without a query, fragment or management token." } } } } } };
const errors = { "400": { description: "Invalid name, URL or source message." }, "403": { description: "Cross-origin change forbidden." }, "404": { description: "Resource not found." }, "409": { description: "Collection is full or the existing link has a different type." }, "410": { description: "Group or conversation expired." }, "413": { description: "Request exceeds 4 KiB." }, "429": { description: "Rate limit reached." }, "503": { description: "Service unavailable. For link writes, retry the identical request to repair any partial backlink." } };
const chatSchema = { type: "object", required: ["conversation_url", "title", "status"], properties: { conversation_url: { type: "string", format: "uri" }, title: { type: "string" }, status: { type: "string", enum: ["active", "unavailable", "unknown"] }, latest_message: { type: "integer" }, expires_at: { type: "string", format: "date-time" } } };
const groupResponse = { description: "Shared collection. Holding its URL grants access to its chats and membership editing. Reads do not extend expiry.", content: { "application/json": { schema: { type: "object", required: ["name", "group_url", "expires_at", "chats"], properties: { name: { type: "string" }, group_url: { type: "string", format: "uri" }, expires_at: { type: "string", format: "date-time" }, chats: { type: "array", maxItems: 50, items: chatSchema } } } } } };
const linksResponse = { description: "Reciprocal connections. No group membership is exposed. Expired targets have no retained title.", content: { "application/json": { schema: { type: "object", required: ["links"], properties: { links: { type: "array", maxItems: 50, items: { ...chatSchema, properties: { ...chatSchema.properties, kind: { type: "string", enum: ["related", "source", "branch"] }, source_message: { type: ["integer", "null"] } } } } } } } } };

export const ORGANIZATION_PATHS = {
  "/groups": { post: { summary: "Create a shared group; expires 30 days after its last edit", requestBody: nameBody, responses: { "201": groupResponse, ...errors } } },
  "/groups/{group}": {
    parameters: [capability("group")],
    get: { summary: "Read a shared group", responses: { "200": groupResponse, ...errors } },
    patch: { summary: "Rename a shared group and refresh its expiry", requestBody: nameBody, responses: { "200": groupResponse, ...errors } },
  },
  "/g/{group}": { get: { summary: "Open the group browser page, or read JSON", parameters: [capability("group")], responses: { "200": groupResponse, ...errors } } },
  "/groups/{group}/chats": { post: { summary: "Share a conversation with the group (idempotent membership)", parameters: [capability("group")], requestBody: chatBody, responses: { "200": groupResponse, ...errors } } },
  "/groups/{group}/chats/{room}": { delete: { summary: "Remove membership without deleting the conversation", parameters: [capability("group"), capability("room")], responses: { "200": groupResponse, ...errors } } },
  "/{room}/links": {
    parameters: [capability("room")],
    get: { summary: "List related conversations, sources and branches", responses: { "200": linksResponse, ...errors } },
    post: { summary: "Connect two conversations, explicitly sharing access in both directions", description: "Repeat the identical request after a failure. Both writes must complete before success; writes to separate rooms are not atomic. Omitting source_message makes a related link. Setting it makes this room the source and the other room its branch. Messages and expiry are unchanged.", requestBody: { required: true, content: { "application/json": { schema: { ...chatBody.content["application/json"].schema, properties: { ...chatBody.content["application/json"].schema.properties, source_message: { type: "integer", minimum: 1, description: "Existing message in the source room." } } } } } }, responses: { "200": linksResponse, ...errors } },
  },
  "/{room}/links/{other_room}": { delete: { summary: "Remove both links; does not revoke previously shared access", parameters: [capability("room"), capability("other_room")], responses: { "200": linksResponse, ...errors } } },
} as const;
