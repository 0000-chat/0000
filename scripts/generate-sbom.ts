import { execFileSync } from "node:child_process"
import { writeFileSync } from "node:fs"
import { readFile } from "node:fs/promises"

type PackageJson = {
  name: string
  version: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

type Component = {
  type: "library"
  name: string
  version: string
  "bom-ref": string
  purl: string
  scope?: "required" | "optional"
}

function parsePackageLine(line: string): { name: string; version: string } | undefined {
  const cleaned = line
    .replace(/^[\s│├└─]+/, "")
    .trim()

  if (!cleaned || cleaned.includes(" node_modules")) {
    return undefined
  }

  const atIndex = cleaned.lastIndexOf("@")
  if (atIndex <= 0 || atIndex === cleaned.length - 1) {
    return undefined
  }

  return {
    name: cleaned.slice(0, atIndex),
    version: cleaned.slice(atIndex + 1),
  }
}

function componentFor(name: string, version: string, required: Set<string>): Component {
  const encodedName = name.startsWith("@")
    ? `@${name.slice(1).split("/").map(encodeURIComponent).join("/")}`
    : encodeURIComponent(name)
  return {
    "bom-ref": `pkg:npm/${encodedName}@${encodeURIComponent(version)}`,
    name,
    purl: `pkg:npm/${encodedName}@${encodeURIComponent(version)}`,
    scope: required.has(name) ? "required" : "optional",
    type: "library",
    version,
  }
}

async function main(): Promise<void> {
  const packageJson = JSON.parse(await readFile("package.json", "utf8")) as PackageJson
  const required = new Set(Object.keys(packageJson.dependencies ?? {}))
  const listed = execFileSync("bun", ["pm", "ls", "--all"], { encoding: "utf8" })
  const componentsByRef = new Map<string, Component>()

  for (const line of listed.split("\n")) {
    const parsed = parsePackageLine(line)
    if (!parsed) {
      continue
    }
    const component = componentFor(parsed.name, parsed.version, required)
    componentsByRef.set(component["bom-ref"], component)
  }

  const rootRef = `pkg:npm/${encodeURIComponent(packageJson.name)}@${encodeURIComponent(packageJson.version)}`
  const bom = {
    "$schema": "http://cyclonedx.org/schema/bom-1.5.schema.json",
    bomFormat: "CycloneDX",
    components: [...componentsByRef.values()].sort((a, b) => a.name.localeCompare(b.name)),
    metadata: {
      component: {
        "bom-ref": rootRef,
        name: packageJson.name,
        type: "application",
        version: packageJson.version,
      },
      timestamp: new Date().toISOString(),
      tools: [
        {
          name: "scripts/generate-sbom.ts",
          vendor: "0000 Chat",
        },
      ],
    },
    serialNumber: `urn:uuid:${crypto.randomUUID()}`,
    specVersion: "1.5",
    version: 1,
  }

  writeFileSync("sbom.cdx.json", `${JSON.stringify(bom, null, 2)}\n`)
}

await main()
