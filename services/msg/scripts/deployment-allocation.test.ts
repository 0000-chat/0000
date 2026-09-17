import { expect, test } from "bun:test";

import { buildDeploymentVersionSpecs } from "./deployment-allocation";

const versionA = "11111111-2222-4333-8444-555555555555";
const versionB = "66666666-7777-4888-8999-aaaaaaaaaaaa";

test("builds an exact single-version rollback allocation", () => {
  expect(buildDeploymentVersionSpecs(
    { versions: [{ version_id: versionA, percentage: 100 }] },
  )).toEqual([`${versionA}@100%`]);
});

test("builds an exact split-traffic rollback allocation", () => {
  expect(buildDeploymentVersionSpecs(
    {
      versions: [
        { version_id: versionA, percentage: 70 },
        { version_id: versionB, percentage: 30 },
      ],
    },
  )).toEqual([`${versionA}@70%`, `${versionB}@30%`]);
});

test("accepts an active version that is older than the recent versions list", () => {
  expect(buildDeploymentVersionSpecs(
    { versions: [{ version_id: versionA, percentage: 100 }] },
  )).toEqual([`${versionA}@100%`]);
});

test("rejects incomplete deployment allocations", () => {
  expect(() => buildDeploymentVersionSpecs(
    { versions: [{ version_id: versionA, percentage: 99 }] },
  )).toThrow("total 100%");
});

test("rejects malformed version IDs and invalid percentages", () => {
  expect(() => buildDeploymentVersionSpecs(
    { versions: [{ version_id: "not-a-version-id", percentage: 100 }] },
  )).toThrow("valid UUID");
  expect(() => buildDeploymentVersionSpecs(
    { versions: [{ version_id: versionA, percentage: 101 }] },
  )).toThrow("outside 0-100%");
});
