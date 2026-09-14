import { describe, expect, it } from "vitest";
import {
  AccountGrantMutationSchema,
  AccountGrantUpdateSchema,
  GroupParticipantsRequestSchema,
  GroupRenameRequestSchema,
} from "../src/index";

const groupTarget = {
  identity_id: "identity_one",
  account_id: "account_one",
  conversation_id: "conversation_one",
  expected_revision: "revision_one",
  idempotency_key: "group-action-001",
};

const participants = [
  { contact_id: "contact_one", candidate_revision: "a".repeat(64) },
];

describe("acceptance action request schemas", () => {
  it("keeps group rename and participant mutations strict per route", () => {
    expect(
      GroupRenameRequestSchema.safeParse({
        ...groupTarget,
        name: "Renamed group",
      }).success,
    ).toBe(true);
    expect(
      GroupRenameRequestSchema.safeParse({
        ...groupTarget,
        name: "Renamed group",
        participants,
      }).success,
    ).toBe(false);

    expect(
      GroupParticipantsRequestSchema.safeParse({
        ...groupTarget,
        participants,
      }).success,
    ).toBe(true);
    expect(
      GroupParticipantsRequestSchema.safeParse({
        ...groupTarget,
        participants,
        name: "Unexpected on participant route",
      }).success,
    ).toBe(false);
  });

  it("keeps grant create and update fields strict per method", () => {
    const create = {
      membership_id: "membership_one",
      identity_id: "identity_one",
      account_id: "account_one",
      operation_scope: "conversation.read" as const,
      chat_scope: "all_chats" as const,
      chat_ids: [],
      idempotency_key: "grant-create-001",
    };
    const update = {
      operation_scope: "conversation.read" as const,
      chat_scope: "all_chats" as const,
      chat_ids: [],
      idempotency_key: "grant-update-001",
    };

    expect(AccountGrantMutationSchema.safeParse(create).success).toBe(true);
    expect(
      AccountGrantMutationSchema.safeParse({ ...create, grant_id: "grant_one" })
        .success,
    ).toBe(false);
    expect(AccountGrantUpdateSchema.safeParse(update).success).toBe(true);
    expect(
      AccountGrantUpdateSchema.safeParse({
        ...update,
        membership_id: "membership_one",
      }).success,
    ).toBe(false);
  });
});
