import { describe, expect, it } from "vitest";
import {
  AccountGrantMutationSchema,
  AccountGrantUpdateSchema,
  GroupParticipantsRequestSchema,
  GroupRenameRequestSchema,
} from "../src/index";
import actionRequestVectors from "../../../tests/fixtures/acceptance-action-request-vectors.json";

describe("acceptance action request schemas", () => {
  it("keeps group rename and participant mutations strict per route", () => {
    const rename = actionRequestVectors.group_rename;
    const participantMutation = actionRequestVectors.group_participants;
    expect(rename.methods).toEqual(["PATCH"]);
    expect(participantMutation.methods).toEqual(["POST", "DELETE"]);
    expect(GroupRenameRequestSchema.safeParse(rename.valid).success).toBe(true);
    expect(GroupRenameRequestSchema.safeParse(rename.invalid).success).toBe(false);
    expect(
      GroupParticipantsRequestSchema.safeParse(participantMutation.valid).success,
    ).toBe(true);
    expect(
      GroupParticipantsRequestSchema.safeParse(participantMutation.invalid).success,
    ).toBe(false);
  });

  it("keeps grant create and update fields strict per method", () => {
    const create = actionRequestVectors.grant_create;
    const update = actionRequestVectors.grant_update;
    expect(create.methods).toEqual(["POST"]);
    expect(update.methods).toEqual(["PATCH"]);
    expect(AccountGrantMutationSchema.safeParse(create.valid).success).toBe(true);
    expect(AccountGrantMutationSchema.safeParse(create.invalid).success).toBe(false);
    expect(AccountGrantUpdateSchema.safeParse(update.valid).success).toBe(true);
    expect(AccountGrantUpdateSchema.safeParse(update.invalid).success).toBe(false);
  });
});
