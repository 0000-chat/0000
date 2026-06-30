import { describe, expect, test } from "bun:test";

import {
  attributionSessionKeyPart,
  gitAuthorEnv,
  sanitizeGitAuthor,
} from "./git-attribution";
import type { BridgeSessionQueueItem } from "./session-manager";

describe("git attribution", () => {
  test("accepts complete linked GitHub author metadata", () => {
    const item: BridgeSessionQueueItem = {
      codeAttribution: {
        gitAuthorEmail: " don@users.noreply.github.com ",
        gitAuthorName: " Don ",
        githubLogin: "don",
        provider: "github",
        providerAccountId: "12345",
        requestedByUserId: "user_123",
        source: "github-linked-account",
      },
      id: "queue-1",
    };

    expect(sanitizeGitAuthor(item)).toEqual({
      email: "don@users.noreply.github.com",
      name: "Don",
    });
    expect(gitAuthorEnv({ email: "don@users.noreply.github.com", name: "Don" })).toEqual({
      GIT_AUTHOR_EMAIL: "don@users.noreply.github.com",
      GIT_AUTHOR_NAME: "Don",
    });
    expect(attributionSessionKeyPart(item)).toMatch(/^git-author:[a-f0-9]{16}$/);
  });

  test("rejects incomplete or unsafe author metadata", () => {
    expect(
      sanitizeGitAuthor({
        codeAttribution: {
          gitAuthorEmail: "don@example.com\nGIT_COMMITTER_EMAIL=bad@example.com",
          gitAuthorName: "Don",
          source: "github-linked-account",
        },
        id: "queue-1",
      }),
    ).toBeUndefined();
    expect(
      sanitizeGitAuthor({
        codeAttribution: {
          gitAuthorEmail: "don@example.com",
          source: "0000-user",
        },
        id: "queue-2",
      }),
    ).toBeUndefined();
  });
});
