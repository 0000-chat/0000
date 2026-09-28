#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJson, stableJson } from "./lib.mjs";

const SHA_RE = /^[0-9a-f]{40}$/;
const RUN_ID_RE = /^[0-9]+$/;

function argument(name, fallback = undefined) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

/**
 * Project the public release plan/record into Cloud's workflow-dispatch
 * contract. The public record contains more provenance than Cloud needs at
 * dispatch time; only the immutable selection and changed paths cross the
 * boundary.
 */
export function createReleaseEvent(plan, record, provenance) {
  if (!plan || !record || !provenance) throw new Error("plan, record, and provenance are required");
  if (!SHA_RE.test(plan.source_commit)) throw new Error("release event source commit must be a full SHA");
  if (record.release?.source?.commit !== plan.source_commit) {
    throw new Error("release record source commit does not match the release plan");
  }
  if (record.release?.version !== plan.release_version) {
    throw new Error("release record version does not match the release plan");
  }
  if (!Array.isArray(plan.changed_files) || plan.changed_files.length === 0) {
    throw new Error("release event requires at least one changed path");
  }
  if (typeof provenance.workflow !== "string" || provenance.workflow.trim() === "") {
    throw new Error("release event provenance.workflow is required");
  }
  if (typeof provenance.run_id !== "string" || !RUN_ID_RE.test(provenance.run_id)) {
    throw new Error("release event provenance.run_id must be numeric");
  }
  const workflowRunUrl = typeof provenance.workflow_run_url === "string" ? provenance.workflow_run_url.trim() : "";
  if (!workflowRunUrl) {
    throw new Error("release event provenance.workflow_run_url is required");
  }
  const artifacts = record.cloud_selection?.artifacts;
  if (!Array.isArray(artifacts)) throw new Error("release record is missing cloud artifact selection");
  const attestation = typeof provenance.attestation === "string" ? provenance.attestation.trim() : "";
  if (artifacts.length > 0 && !attestation) {
    throw new Error("runtime release event provenance.attestation is required");
  }
  if (artifacts.length === 0 && attestation) {
    throw new Error("docs-only release event cannot claim an artifact attestation");
  }

  const normalizedProvenance = {
    workflow: provenance.workflow,
    run_id: provenance.run_id
  };
  if (attestation) normalizedProvenance.attestation = attestation;
  if (workflowRunUrl) normalizedProvenance.workflow_run_url = workflowRunUrl;

  return {
    schema_version: 1,
    product: "0000",
    source_repository: "0000-chat/0000",
    release: {
      version: plan.release_version,
      commit: plan.source_commit,
      artifacts: artifacts
        .map(({ name, version, digest, compatibility, kind, media_type, asset_name }) => ({
          name,
          version,
          digest,
          compatibility,
          kind,
          media_type,
          asset_name
        }))
        .sort((left, right) => left.name.localeCompare(right.name)),
      provenance: normalizedProvenance
    },
    changed_paths: [...new Set(plan.changed_files)].sort()
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const planPath = argument("--plan");
  const recordPath = argument("--record");
  const outputPath = argument("--output");
  const workflow = argument("--workflow", process.env.GITHUB_WORKFLOW);
  const runId = argument("--run-id", process.env.GITHUB_RUN_ID);
  const attestation = argument("--attestation", process.env.GITHUB_ATTESTATION_URL);
  const workflowRunUrl = argument("--workflow-run-url", process.env.GITHUB_RUN_URL);
  if (!planPath || !recordPath || !outputPath || !workflow || !runId || !workflowRunUrl) {
    throw new Error(
      "usage: event.mjs --plan PLAN --record RECORD --output FILE --workflow NAME --run-id ID --workflow-run-url URL [--attestation URL]"
    );
  }

  const event = createReleaseEvent(readJson(planPath), readJson(recordPath), {
    workflow,
    run_id: runId,
    attestation,
    workflow_run_url: workflowRunUrl
  });
  fs.writeFileSync(outputPath, stableJson(event), "utf8");
  process.stdout.write(stableJson(event));
}
