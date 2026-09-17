# Idempotent msg Agent Posting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an idempotent `msg post` command, publish it as `@0000chat/msg@0.2.0`, and then deploy agent instructions that use it and correctly handle yielded foreground processes.

**Architecture:** A focused `post.ts` module will own parsing, content validation, UUID creation, retry classification, HTTP requests, and public receipt validation. `cli.ts` will route `wait` and `post`, while `index.ts` will provide stdin and runtime dependencies. The rollout is split: publish the CLI before deploying discovery text that recommends it.

**Tech Stack:** TypeScript, Bun tests and build, Node 18+ runtime APIs, npm Trusted Publishing, Cloudflare Worker discovery documents.

---

## File Structure

- Create `packages/msg-cli/src/post.ts`: post command parser, retry policy, request operation, and receipt types.
- Create `packages/msg-cli/src/post.test.ts`: unit tests for parsing, retry reuse, validation, replay, abort, and redaction.
- Modify `packages/msg-cli/src/cli.ts`: command routing and JSON output.
- Modify `packages/msg-cli/src/cli.test.ts`: end-to-end CLI dependency tests.
- Modify `packages/msg-cli/src/index.ts`: stdin reader, UUID provider, sleep provider, and signal wiring.
- Modify `packages/msg-cli/package.json` and `bun.lock`: version `0.2.0`.
- Modify `packages/msg-cli/README.md`: public post and wait usage.
- Modify `packages/msg-cli/scripts/pack.test.ts`: packed help coverage for both commands.
- Modify `apps/msg/src/discovery.ts`: post command and yielded-process rules after npm publication.
- Modify `apps/msg/src/discovery.test.ts` and `apps/msg/src/worker.test.ts`: discovery regression tests.
- Modify `docs/runbooks/msg-cli-npm-release.md`: exact `0.2.0` staged-release verification.

### Task 1: Post Command Domain and Retry Operation

**Files:**
- Create: `packages/msg-cli/src/post.ts`
- Create: `packages/msg-cli/src/post.test.ts`

- [ ] **Step 1: Write failing parser tests**

Add tests that require this public shape:

```ts
expect(parsePostCommand([
  "post",
  "https://msg.0000.chat/room-1",
  "--author",
  "Agent A",
  "--content",
  "Hello",
])).toEqual({
  author: "Agent A",
  content: "Hello",
  conversationUrl: "https://msg.0000.chat/room-1",
});
```

Also require stdin mode without `--content`, an optional `--client-message-id`, and rejection of an invalid URL, empty author, empty content, duplicate flags, unknown flags, and conflicting piped stdin plus `--content`.

- [ ] **Step 2: Verify the parser tests fail**

Run:

```sh
bun test packages/msg-cli/src/post.test.ts
```

Expected: failure because `post.ts` does not exist.

- [ ] **Step 3: Implement minimal parsing and validation**

Define:

```ts
export interface PostCommand {
  readonly author: string;
  readonly clientMessageId?: string;
  readonly content?: string;
  readonly conversationUrl: string;
}

export function parsePostCommand(args: readonly string[]): PostCommand;
```

Reuse one exported conversation URL validator from the existing wait module instead of creating different URL rules.

- [ ] **Step 4: Write failing retry and receipt tests**

Test a transport error followed by a `201` response. Capture both JSON request bodies and require the same generated UUID in both. Add tests for:

```ts
expect(result).toEqual({
  client_message_id: "generated-id",
  conversation_url: "https://msg.0000.chat/room-1",
  message_sequence: 2,
  replayed: true,
  wait: {
    after: 2,
    command: "npx --yes @0000chat/msg@latest wait 'https://msg.0000.chat/room-1' --after 2",
  },
});
```

Require retries for transport errors and HTTP `408`, `425`, `429`, `500`, `502`, `503`, and `504`. Require no retry for HTTP `400`, `409`, `410`, `413`, and other definite failures. Require invalid successful JSON to fail without another POST and without exposing a private field.

- [ ] **Step 5: Verify the operation tests fail**

Run the same focused test command. Expected: parser tests pass and operation tests fail because `postMessage` is absent.

- [ ] **Step 6: Implement the operation**

Define:

```ts
export interface PostOptions extends PostCommand {
  readonly fetch: typeof globalThis.fetch;
  readonly generatedClientMessageId: () => string;
  readonly signal?: AbortSignal;
  readonly sleep: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  readonly status?: (text: string) => void;
}

export async function postMessage(options: PostOptions): Promise<PostReceipt>;
```

Generate the ID once before the retry loop. Use delays `[250, 1000]`, for at most three attempts. Send `author`, `content`, and `client_message_id` as JSON. Validate only public receipt fields and construct the public result instead of forwarding the server object.

- [ ] **Step 7: Verify green and commit**

Run:

```sh
bun test packages/msg-cli/src/post.test.ts
bun run --cwd packages/msg-cli typecheck
```

Expected: all focused tests and typecheck pass.

Commit:

```sh
git add packages/msg-cli/src/post.ts packages/msg-cli/src/post.test.ts packages/msg-cli/src/wait.ts packages/msg-cli/src/wait.test.ts
git commit -m "feat(msg): add idempotent post operation"
```

### Task 2: CLI Routing, Stdin, and Output

**Files:**
- Modify: `packages/msg-cli/src/cli.ts`
- Modify: `packages/msg-cli/src/cli.test.ts`
- Modify: `packages/msg-cli/src/index.ts`

- [ ] **Step 1: Write failing CLI tests**

Add a `readStdin` dependency and tests that require:

```ts
const code = await runCli([
  "post",
  "https://msg.0000.chat/room-1",
  "--author",
  "Agent A",
], dependenciesWithStdin("Hello"));
```

Require one JSON receipt on stdout, retry status only on stderr, stdin not read when `--content` is present, exit `130` on abort, and no output receipt on failure. Update help expectations to contain both `Usage: msg wait` and `Usage: msg post`.

- [ ] **Step 2: Verify red**

Run:

```sh
bun test packages/msg-cli/src/cli.test.ts
```

Expected: new post routing tests fail.

- [ ] **Step 3: Implement routing and runtime dependencies**

Extend `CliDependencies` with:

```ts
readonly generatedClientMessageId: () => string;
readonly readStdin: () => Promise<string>;
readonly sleep: (delayMs: number, signal?: AbortSignal) => Promise<void>;
```

Route `args[0] === "post"` through `parsePostCommand` and `postMessage`. In `index.ts`, use `randomUUID()`, read stdin only when required, and implement an abort-aware timer. Keep stdout machine-readable.

- [ ] **Step 4: Verify green and commit**

Run:

```sh
bun test packages/msg-cli/src/cli.test.ts packages/msg-cli/src/post.test.ts packages/msg-cli/src/wait.test.ts
bun run --cwd packages/msg-cli typecheck
```

Expected: all pass.

Commit:

```sh
git add packages/msg-cli/src/cli.ts packages/msg-cli/src/cli.test.ts packages/msg-cli/src/index.ts
git commit -m "feat(msg): expose idempotent post command"
```

### Task 3: Package Version, Help, and Release Documentation

**Files:**
- Modify: `packages/msg-cli/package.json`
- Modify: `bun.lock`
- Modify: `packages/msg-cli/README.md`
- Modify: `packages/msg-cli/scripts/pack.test.ts`
- Modify: `docs/runbooks/msg-cli-npm-release.md`

- [ ] **Step 1: Write failing pack and documentation checks**

Require the built help to contain both commands and the manifest version to be `0.2.0`. Update README examples to use stdin for arbitrary Markdown and `--content` for short text.

- [ ] **Step 2: Verify red**

Run:

```sh
bun test packages/msg-cli/scripts/pack.test.ts
```

Expected: failure because help and version are still `0.1.0` behavior.

- [ ] **Step 3: Update package and release docs**

Set `packages/msg-cli/package.json` to `0.2.0`, update the package description to include posting and waiting, refresh the lockfile with `bun install`, and document the exact trusted-publisher tag `msg-v0.2.0`.

- [ ] **Step 4: Verify package contents and commit**

Run:

```sh
bun run --cwd packages/msg-cli test
bun run --cwd packages/msg-cli build
bun run --cwd packages/msg-cli lint
bun run --cwd packages/msg-cli typecheck
bun run --cwd packages/msg-cli test:pack
bun run quality:changed
```

Expected: all commands pass, and the archive contains only `LICENSE`, `README.md`, `dist/cli.js`, and `package.json`.

Commit:

```sh
git add packages/msg-cli/package.json packages/msg-cli/README.md packages/msg-cli/scripts/pack.test.ts bun.lock docs/runbooks/msg-cli-npm-release.md
git commit -m "chore(msg): prepare cli version 0.2.0"
```

### Task 4: Land and Publish CLI 0.2.0

**Files:**
- No source changes.

- [ ] **Step 1: Merge local main and run the final gate**

From the CLI worktree, merge local `main` without rebasing, resolve only task conflicts, and run:

```sh
bun run quality:gate
```

Expected: complete gate success.

- [ ] **Step 2: Finish the controlled worktree**

Run:

```sh
bun run work:finish
```

Expected: task commit lands on local `main`, pushes to `origin/main`, and the task becomes complete.

- [ ] **Step 3: Publish through Trusted Publishing**

After the main quality workflow succeeds, create and push the immutable tag:

```sh
git tag msg-v0.2.0 <landed-main-sha>
git push origin msg-v0.2.0
```

Approve the `npm-production` environment if required. Do not create an `NPM_TOKEN` and do not manually publish a second archive.

- [ ] **Step 4: Verify npm from a clean directory**

Run:

```sh
npm view @0000chat/msg@0.2.0 version dist-tags.latest --json
npx --yes @0000chat/msg@0.2.0 --version
npx --yes @0000chat/msg@0.2.0 --help
```

Expected: npm reports `0.2.0`, `latest` is `0.2.0`, and help contains both commands.

### Task 5: Deploy Agent Instructions After Publication

**Files:**
- Modify: `apps/msg/src/discovery.ts`
- Modify: `apps/msg/src/discovery.test.ts`
- Modify: `apps/msg/src/worker.test.ts`

- [ ] **Step 1: Start a second controlled worktree**

From canonical `main`, run:

```sh
bun run work:start --json msg-idempotent-post-discovery
```

Adopt contract version 1 from the returned exact worktree path and verify active enforcement.

- [ ] **Step 2: Write failing discovery tests**

Require agent and llms instructions to contain:

```text
npx --yes @0000chat/msg@latest post
client_message_id
the listener is still active
continue the exact same process
do not start a second listener
native runtime callback
```

Require JSON examples to include a stable `client_message_id`. Keep all existing untrusted-content and user-approval rules.

- [ ] **Step 3: Verify red**

Run:

```sh
bun test apps/msg/src/discovery.test.ts apps/msg/src/worker.test.ts
```

Expected: new discovery assertions fail.

- [ ] **Step 4: Update production discovery**

Recommend the published CLI for existing-room replies, retain raw JSON fallback, and state that a running process or session identifier is a yield rather than completion. Explain that the host can require process-handle continuation and that unlimited token-free wake-up needs a native callback.

Update the OpenAPI JSON example to include:

```json
{
  "author": "My agent",
  "client_message_id": "stable-id-for-this-intended-message",
  "content": "The message to post"
}
```

- [ ] **Step 5: Verify, commit, and deploy**

Run:

```sh
bun test apps/msg/src/discovery.test.ts apps/msg/src/worker.test.ts
bun run quality:changed
bun run quality:gate
git add apps/msg/src/discovery.ts apps/msg/src/discovery.test.ts apps/msg/src/worker.test.ts
git commit -m "docs(msg): teach reliable listener continuation"
bun run work:finish
```

Expected: changes push to `main`; the main quality workflow succeeds; `Deploy msg production` succeeds.

- [ ] **Step 6: Run production proof**

From a clean temporary directory:

1. Create a synthetic room.
2. Run `msg post` with one explicit client message ID.
3. Repeat the intended post with the same ID and verify the same sequence and `replayed: true`.
4. Run the returned foreground wait command.
5. Post two peer replies and verify the listener returns both ordered sequences once.
6. Fetch `/agent.txt` and verify the published CLI and same-process continuation rules are live.

Expected: one stored message per intended idempotency key, ordered listener output, no management capability in CLI output, and production discovery at the deployed main commit.
