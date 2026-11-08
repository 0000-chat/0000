// This consumer intentionally uses only Node built-ins: copy it independently
// of the source workspace, then authenticate archives before extracting them.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const units = ["communicator-control-plane", "communicator-matrix-gateway", "communicator-bridge-images", "platform-worker"];
const packages = ["@0000/contracts", "@0000/platform-client", "@communicator/contracts", "@communicator/test-fixtures"];
const digest = (bytes) => `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
const json = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const safePath = (name) => typeof name === "string" && name.length > 0 && !name.includes("\\") && !name.startsWith("/") && name.split("/").every((part) => part && part !== "." && part !== "..");

export function archiveFiles(bytes) {
  const tar = gunzipSync(bytes, { maxOutputLength: 256 * 1024 * 1024 });
  const files = new Map();
  const seen = new Set();
  let offset = 0;
  const text = (block) => block.toString("utf8").split("\0", 1)[0];
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const prefix = text(header.subarray(345, 500));
    const name = `${prefix ? `${prefix}/` : ""}${text(header.subarray(0, 100))}`.replace(/\/$/, "");
    const size = parseInt(text(header.subarray(124, 136)).trim(), 8);
    const mode = parseInt(text(header.subarray(100, 108)).trim(), 8);
    const checksum = [...header].reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    assert.equal(checksum, parseInt(text(header.subarray(148, 156)).trim(), 8), "invalid tar header checksum");
    assert.ok(safePath(name) && !seen.has(name), `unsafe or duplicate archive path: ${name}`);
    seen.add(name);
    assert.ok([0, 48, 53].includes(header[156]), "archive links and special files are forbidden");
    assert.ok(Number.isSafeInteger(size) && size >= 0 && offset + 512 + size <= tar.length, "invalid tar size");
    if (header[156] !== 53) files.set(name, { bytes: tar.subarray(offset + 512, offset + 512 + size), mode });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  assert.ok(files.size > 0, "empty archive");
  for (const name of files.keys()) for (const other of files.keys()) assert.ok(!other.startsWith(`${name}/`), "archive file/directory collision");
  return files;
}

function assertMigrationLedger(files, ledger) {
  assert.ok(Array.isArray(ledger) && ledger.length > 0, "missing D1 migration ledger");
  assert.deepEqual([...files.keys()].filter((file) => file.startsWith("migrations/")).sort(), ledger.map((file) => file.name).sort(), "incomplete migration ledger");
  let previousNumber = -1;
  for (const file of ledger) {
    assert.match(file.name, /^migrations\/[0-9]{4,}_[a-z0-9_]+\.sql$/);
    const number = Number(path.basename(file.name).split("_")[0]);
    assert.ok(Number.isSafeInteger(number) && number > previousNumber, "unordered migrations");
    previousNumber = number;
    assert.equal(digest(files.get(file.name).bytes), file.digest, `migration checksum mismatch: ${file.name}`);
  }
}

export function assertForwardState(previous, current) {
  assert.equal(current.state.compatibility, previous.state.compatibility, "incompatible persistent-state version");
  assert.equal(current.state.migration_policy, "forward-only", "missing forward-migration policy");
  assert.deepEqual(current.state.persistent, previous.state.persistent, "persistent storage contract changed");
  assert.deepEqual(current.state.embedded_schema, previous.state.embedded_schema, "embedded state changed: migration review required");
  const old = previous.migration_files ?? [];
  const next = current.migration_files ?? [];
  assert.deepEqual(next.slice(0, old.length), old, "migration history is not append-only");
  if (previous.images) assert.deepEqual(current.images, previous.images, "bridge image migration review required");
}

export function verifyComposition({ record, directory, commit, compatibility, attest, previous, extract }) {
  assert.match(commit, /^[a-f0-9]{40}$/);
  assert.equal(record.product, "0000");
  assert.equal(record.release.source.repository, "0000-chat/0000");
  assert.equal(record.release.source.commit, commit, "wrong source revision");
  assert.equal(record.release.version, `v0.0.0-${commit}`, "wrong release version");
  assert.deepEqual(record.release.compatibility, compatibility, "unsupported compatibility");
  const manifests = {};
  const verified = [];
  for (const name of units) {
    const candidates = record.artifacts.filter((entry) => entry.name === name);
    assert.equal(candidates.length, 1, `missing or duplicate required artifact: ${name}`);
    const artifact = candidates[0];
    assert.equal(artifact.version, record.release.version, `incompatible bundle version: ${name}`);
    assert.equal(artifact.source_commit, commit, `wrong bundle revision: ${name}`);
    assert.deepEqual(artifact.compatibility, compatibility, `incompatible bundle: ${name}`);
    assert.ok(safePath(artifact.asset_name) && !artifact.asset_name.includes("/"), "unsafe asset name");
    const archive = path.join(directory, artifact.asset_name);
    const descriptor = fs.openSync(archive, "r");
    let bytes;
    try {
      const stat = fs.fstatSync(descriptor);
      assert.ok(stat.isFile() && stat.size <= 256 * 1024 * 1024, "archive exceeds 256 MiB limit or is not a file");
      const buffer = Buffer.alloc(stat.size + 1);
      let length = 0;
      while (length < buffer.length) {
        const count = fs.readSync(descriptor, buffer, length, buffer.length - length, null);
        if (count === 0) break;
        length += count;
      }
      assert.equal(length, stat.size, "archive size changed during bounded read");
      bytes = buffer.subarray(0, length);
    } finally { fs.closeSync(descriptor); }
    assert.equal(digest(bytes), artifact.digest, `archive checksum mismatch: ${name}`);
    if (attest) {
      const snapshot = fs.mkdtempSync(path.join(os.tmpdir(), "communicator-attestation-"));
      try {
        const subject = path.join(snapshot, artifact.asset_name);
        fs.writeFileSync(subject, bytes, { mode: 0o400, flag: "wx" });
        attest(subject, commit);
      } finally { fs.rmSync(snapshot, { recursive: true, force: true }); }
    }
    const files = archiveFiles(bytes);
    const manifestBytes = files.get("artifact-manifest.json")?.bytes;
    assert.ok(manifestBytes, `missing manifest: ${name}`);
    const manifest = JSON.parse(manifestBytes);
    assert.equal(manifest.schema_version, 1, "unsupported manifest schema");
    assert.equal(manifest.product, "0000", "wrong manifest product");
    for (const [key, value] of Object.entries({ name, version: artifact.version, source_commit: commit, compatibility })) {
      assert.deepEqual(manifest[key], value, `manifest ${key} mismatch: ${name}`);
    }
    if (name !== "platform-worker") {
      assert.equal(artifact.artifact_format, "0000-communicator-bundle-v1");
      assert.equal(digest(manifestBytes), artifact.manifest_digest, `manifest digest mismatch: ${name}`);
      assert.equal(manifest.artifact_format, artifact.artifact_format);
      const role = { "communicator-control-plane": "worker", "communicator-matrix-gateway": "native", "communicator-bridge-images": "bridge" }[name];
      assert.equal(manifest.role, role);
      assert.equal(artifact.kind, `communicator-${role}-bundle`);
      assert.equal(manifest.kind, artifact.kind);
      assert.equal(manifest.state?.compatibility, "communicator-state-v1");
      assert.equal(manifest.state?.migration_policy, "forward-only");
      assert.equal(manifest.state?.rollback, "restore-compatible-backup");
      assert.ok(manifest.state.persistent.length > 0, "missing persistent-state requirements");
      if (role !== "bridge") assert.ok(manifest.state.embedded_schema?.length > 0, "missing embedded-state contract");
      assert.deepEqual([...files.keys()].filter((file) => file !== "artifact-manifest.json").sort(), manifest.files.map((file) => file.name).sort(), "unexpected or missing bundle files");
      for (const file of manifest.files) {
        assert.equal(digest(files.get(file.name).bytes), file.digest, `payload checksum mismatch: ${file.name}`);
        assert.equal((files.get(file.name).mode & 0o111) !== 0, file.executable, `payload mode mismatch: ${file.name}`);
      }
      if (role === "worker") {
        assert.deepEqual(manifest.dependencies.map((entry) => entry.name).sort(), [...packages].sort(), "missing required contracts/platform-client closure");
        assert.ok(manifest.dependencies.every((entry) => entry.delivery === "bundled" && entry.source_files?.length > 0), "unbundled workspace dependency");
        assert.ok(files.has("worker.js") && files.has("assets/index.html") && files.has("wrangler.json"), "missing Worker/UI inputs");
        assert.deepEqual(JSON.parse(files.get("wrangler.json").bytes), manifest.bindings, "binding contract mismatch");
        assertMigrationLedger(files, manifest.migration_files);
      }
      if (role === "native") {
        assert.equal(manifest.native.target, "x86_64-unknown-linux-gnu", "unsupported native target");
        assert.equal(manifest.state.restart_prevent_exit_status, 78);
        assert.ok(files.get("communicator-matrix-gateway")?.mode & 0o111, "native executable missing");
      }
      if (role === "bridge") {
        const lock = files.get("deploy/images.lock.env")?.bytes.toString();
        assert.ok(lock, "missing bridge image lock");
        const entries = lock.trim().split(/\r?\n/).map((line) => line.split("="));
        assert.equal(entries.length, 6, "missing bridge image");
        assert.deepEqual(entries.map(([key]) => key).sort(), ["CADDY_IMAGE", "MESSENGER_IMAGE", "POSTGRES_IMAGE", "SYNAPSE_IMAGE", "TELEGRAM_IMAGE", "WHATSAPP_IMAGE"], "wrong bridge image set");
        for (const [key, value] of entries) assert.match(value, /@sha256:[a-f0-9]{64}$/);
        assert.deepEqual(Object.fromEntries(entries), manifest.images, "bridge image contract mismatch");
        assert.ok(files.has("compose.yaml"), "missing bridge composition");
      }
      if (previous) {
        assert.ok(previous[name], `previous state missing: ${name}`);
        assertForwardState(previous[name], manifest);
      }
    } else {
      assert.equal(artifact.kind, "cloudflare-worker-bundle");
      assert.equal(artifact.artifact_format, "0000-cloudflare-worker-bundle-v1");
      assert.equal(digest(files.get("worker.js")?.bytes ?? Buffer.alloc(0)), artifact.entrypoint_digest, "Platform entrypoint mismatch");
      assertMigrationLedger(files, manifest.migration_files);
      if (previous) {
        assert.ok(previous[name], `previous state missing: ${name}`);
        const old = previous[name].migration_files;
        assert.deepEqual(manifest.migration_files.slice(0, old.length), old, "Platform migration history is not append-only");
      }
    }
    manifests[name] = manifest;
    verified.push({ name, files });
  }
  // Do not leave a partially verified composition on disk.
  if (extract) {
    assert.ok(!fs.existsSync(extract), "extraction destination already exists");
    for (const { name, files } of verified) for (const [relative, file] of files) {
      const destination = path.join(extract, name, relative);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, file.bytes, { mode: file.mode & 0o111 ? 0o755 : 0o644 });
    }
  }
  return manifests;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argument = (name) => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
  const directory = argument("--artifact-dir");
  const recordPath = argument("--record");
  const commit = argument("--commit");
  if (!directory || !recordPath || !commit || !argument("--api") || !argument("--config")) throw new Error("usage: verify-communicator.mjs --record FILE --artifact-dir DIR --commit SHA --api v1 --config v1 [--extract NEW_DIR] [--previous-record FILE --previous-artifact-dir DIR] [--attestation-dir DIR] [--local-integrity-only]");
  const localOnly = process.argv.includes("--local-integrity-only");
  const attest = localOnly ? undefined : (archive, revision) => {
    const bundles = argument("--attestation-dir");
    execFileSync("gh", ["attestation", "verify", archive, "--repo", "0000-chat/0000", "--signer-workflow", "0000-chat/0000/.github/workflows/release.yml", "--source-ref", "refs/heads/main", "--source-digest", revision, "--deny-self-hosted-runners", ...(bundles ? ["--bundle", path.join(bundles, `${path.basename(archive)}.jsonl`)] : [])], { stdio: "pipe" });
  };
  const compatibility = { api: argument("--api"), config: argument("--config") };
  const previousRecord = argument("--previous-record");
  assert.equal(Boolean(previousRecord), Boolean(argument("--previous-artifact-dir")), "previous record and archives must be supplied together");
  const previous = previousRecord ? verifyComposition({ record: json(previousRecord), directory: argument("--previous-artifact-dir"), commit: json(previousRecord).release.source.commit, compatibility, attest }) : undefined;
  verifyComposition({ record: json(recordPath), directory, commit, compatibility, attest, previous, extract: argument("--extract") });
  process.stdout.write(localOnly ? "LOCAL INTEGRITY ONLY: composition passed; signatures/provenance NOT verified; not approved for deployment\n" : "Verified signed Communicator composition, revision, compatibility, dependencies and migration inputs\n");
}
