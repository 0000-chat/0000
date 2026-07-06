#!/usr/bin/env bun
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"

export type PortableAgentToolManifestSnapshot = {
  capabilityPackOrder: readonly string[]
  capabilityPacks: Record<string, unknown>
  generatedBy?: string
  note?: string
  schemaVersion: number
  source?: string
  toolNames: readonly string[]
  tools: Record<string, unknown>
}

export type BridgeAgentToolManifestSnapshot = {
  AGENT_TOOL_CAPABILITY_PACK_ORDER: readonly string[]
  AGENT_TOOL_CAPABILITY_PACKS: Record<string, unknown>
  AGENT_TOOL_MANIFEST: Record<string, unknown>
  AGENT_TOOL_MANIFEST_NAMES: readonly string[]
}

export const DEFAULT_CHAT_REPO = path.resolve(process.cwd(), "../0000-chat")
export const APP_PORTABLE_SNAPSHOT_RELATIVE_PATH = "scripts/agent-tool-mcp-manifest.snapshot.json"
export const BRIDGE_SNAPSHOT_RELATIVE_PATH = "scripts/agent-tool-manifest-snapshot.ts"

function bridgeRepoRoot() {
  return path.resolve(import.meta.dir, "..")
}

export function bridgeSnapshotFromPortableSnapshot(
  portableSnapshot: PortableAgentToolManifestSnapshot,
): BridgeAgentToolManifestSnapshot {
  return {
    AGENT_TOOL_CAPABILITY_PACK_ORDER: portableSnapshot.capabilityPackOrder,
    AGENT_TOOL_CAPABILITY_PACKS: portableSnapshot.capabilityPacks,
    AGENT_TOOL_MANIFEST: portableSnapshot.tools,
    AGENT_TOOL_MANIFEST_NAMES: portableSnapshot.toolNames,
  }
}

export function renderAgentToolManifestSnapshotModule(
  portableSnapshot: PortableAgentToolManifestSnapshot,
): string {
  const snapshot = bridgeSnapshotFromPortableSnapshot(portableSnapshot)
  return `// Portable bridge MCP snapshot generated from 0000 Chat ${APP_PORTABLE_SNAPSHOT_RELATIVE_PATH}.\n// Regenerate with: bun scripts/generate-agent-tool-manifest-snapshot.ts /home/ubuntu/0000-chat --write\n// Do not edit by hand; run --check before bridge releases.\n\nexport const AGENT_TOOL_MANIFEST_SNAPSHOT = (${JSON.stringify(snapshot, null, 2)}) as const\n`
}

async function readPortableSnapshot(chatRepo: string): Promise<PortableAgentToolManifestSnapshot> {
  const snapshotPath = path.join(chatRepo, APP_PORTABLE_SNAPSHOT_RELATIVE_PATH)
  const raw = await readFile(snapshotPath, "utf8")
  const parsed = JSON.parse(raw) as PortableAgentToolManifestSnapshot
  if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.toolNames) || !parsed.tools) {
    throw new Error(`Invalid portable MCP manifest snapshot: ${snapshotPath}`)
  }
  return parsed
}

export async function buildAgentToolManifestSnapshotSource(options: {
  chatRepo?: string
  portableSnapshot?: PortableAgentToolManifestSnapshot
} = {}): Promise<string> {
  const portableSnapshot = options.portableSnapshot ?? await readPortableSnapshot(options.chatRepo ?? DEFAULT_CHAT_REPO)
  return renderAgentToolManifestSnapshotModule(portableSnapshot)
}

export function verifyAgentToolManifestSnapshotModule(options: {
  actual: string | null
  portableSnapshot: PortableAgentToolManifestSnapshot
}): { expected: string; ok: boolean } {
  const expected = renderAgentToolManifestSnapshotModule(options.portableSnapshot)
  return { expected, ok: options.actual === expected }
}

async function writeSnapshot(chatRepo: string) {
  const outputPath = path.join(bridgeRepoRoot(), BRIDGE_SNAPSHOT_RELATIVE_PATH)
  const source = await buildAgentToolManifestSnapshotSource({ chatRepo })
  await writeFile(outputPath, source)
  process.stdout.write(`Wrote ${outputPath}\n`)
}

async function checkSnapshot(chatRepo: string) {
  const outputPath = path.join(bridgeRepoRoot(), BRIDGE_SNAPSHOT_RELATIVE_PATH)
  const portableSnapshot = await readPortableSnapshot(chatRepo)
  const actual = await readFile(outputPath, "utf8").catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null
    throw error
  })
  const result = verifyAgentToolManifestSnapshotModule({ actual, portableSnapshot })
  if (!result.ok) {
    process.stderr.write(
      `agent tool manifest snapshot drifted: ${BRIDGE_SNAPSHOT_RELATIVE_PATH}\n` +
        `Run bun scripts/generate-agent-tool-manifest-snapshot.ts ${chatRepo} --write\n`,
    )
    process.exit(1)
  }
  process.stdout.write(`agent tool manifest snapshot check passed (${portableSnapshot.toolNames.length} tools)\n`)
}

function usage() {
  return `Usage: bun scripts/generate-agent-tool-manifest-snapshot.ts [chat-repo] [--write|--check|--print]\n\nReads ${APP_PORTABLE_SNAPSHOT_RELATIVE_PATH} from the 0000 Chat app repo and vendors it as ${BRIDGE_SNAPSHOT_RELATIVE_PATH}. Default mode is --write for backwards compatibility.`
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const mode = args.find((arg) => arg === "--write" || arg === "--check" || arg === "--print") ?? "--write"
  if (args.includes("--help")) {
    process.stdout.write(`${usage()}\n`)
    process.exit(0)
  }
  const chatRepo = args.find((arg) => !arg.startsWith("--")) ?? DEFAULT_CHAT_REPO
  if (mode === "--check") {
    await checkSnapshot(chatRepo)
  } else if (mode === "--print") {
    process.stdout.write(await buildAgentToolManifestSnapshotSource({ chatRepo }))
  } else {
    await writeSnapshot(chatRepo)
  }
}
