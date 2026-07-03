#!/usr/bin/env bun
import { writeFile } from "node:fs/promises"
import path from "node:path"

const chatRepo = process.argv[2] ?? path.resolve(process.cwd(), "../0000-chat")
const manifestPath = path.join(chatRepo, "apps/convex/convex/agentToolManifest.ts")
const outputPath = path.resolve(import.meta.dir, "agent-tool-manifest-snapshot.ts")

const manifestModule = await import(manifestPath)
const snapshot = {
  AGENT_TOOL_MANIFEST: manifestModule.AGENT_TOOL_MANIFEST,
  AGENT_TOOL_MANIFEST_NAMES: manifestModule.AGENT_TOOL_MANIFEST_NAMES,
  AGENT_TOOL_CAPABILITY_PACKS: manifestModule.AGENT_TOOL_CAPABILITY_PACKS,
  AGENT_TOOL_CAPABILITY_PACK_ORDER: manifestModule.AGENT_TOOL_CAPABILITY_PACK_ORDER,
}

await writeFile(
  outputPath,
  `// Generated from /home/ubuntu/0000-chat/apps/convex/convex/agentToolManifest.ts.\n// Regenerate with: bun scripts/generate-agent-tool-manifest-snapshot.ts /home/ubuntu/0000-chat\n\nexport const AGENT_TOOL_MANIFEST_SNAPSHOT = (${JSON.stringify(snapshot, null, 2)}) as const\n`,
)
console.log(`Wrote ${outputPath}`)
