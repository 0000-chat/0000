import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  authorizeZeroChatFilesystemPath,
  buildZeroChatFilesystemDiagnostic,
} from "./zero-chat-policy"

const tempDirs: string[] = []

async function makeTempWorkspace(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "zero-chat-policy-"))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  const dirs = tempDirs.splice(0)
  await Promise.all(dirs.map((dir) => rm(dir, { force: true, recursive: true })))
})

describe("zero chat filesystem policy", () => {
  test("rejects relative request paths before resolving", async () => {
    const workspace = await makeTempWorkspace()
    let resolveCalls = 0

    const decision = await authorizeZeroChatFilesystemPath({
      operation: "read",
      requestedPath: "notes.txt",
      resolvePath: async (value) => {
        resolveCalls += 1
        return value
      },
      workspaceRoots: [workspace],
    })

    expect(resolveCalls).toBe(0)
    expect(decision).toMatchObject({
      allowed: false,
      reason: "path_not_absolute",
      requestedPath: "notes.txt",
    })
  })

  test("allows resolved absolute paths inside resolved workspace roots", async () => {
    const workspace = await makeTempWorkspace()
    const filePath = path.join(workspace, "notes.txt")
    await writeFile(filePath, "allowed-content")

    const decision = await authorizeZeroChatFilesystemPath({
      operation: "read",
      requestedPath: filePath,
      workspaceRoots: [workspace],
    })

    expect(decision).toMatchObject({
      allowed: true,
      operation: "read",
      requestedPath: filePath,
      resolvedPath: filePath,
      approval: { required: false },
    })
  })

  test("rejects paths outside allowed workspace roots", async () => {
    const workspace = await makeTempWorkspace()
    const outside = await makeTempWorkspace()
    const outsideFile = path.join(outside, "secret.txt")
    await writeFile(outsideFile, "outside-content")

    const decision = await authorizeZeroChatFilesystemPath({
      operation: "read",
      requestedPath: outsideFile,
      workspaceRoots: [workspace],
    })

    expect(decision).toMatchObject({
      allowed: false,
      reason: "path_outside_workspace",
      requestedPath: outsideFile,
      resolvedPath: outsideFile,
    })
  })

  test("resolves symlinks before workspace authorization", async () => {
    const workspace = await makeTempWorkspace()
    const outside = await makeTempWorkspace()
    const outsideFile = path.join(outside, "secret.txt")
    const linkPath = path.join(workspace, "link-to-secret.txt")
    await writeFile(outsideFile, "symlink-target-content")
    await symlink(outsideFile, linkPath)

    const decision = await authorizeZeroChatFilesystemPath({
      operation: "read",
      requestedPath: linkPath,
      workspaceRoots: [workspace],
    })

    expect(decision).toMatchObject({
      allowed: false,
      reason: "path_outside_workspace",
      requestedPath: linkPath,
      resolvedPath: outsideFile,
    })
  })

  test("represents write approval requirements in allowed decisions", async () => {
    const workspace = await makeTempWorkspace()
    const filePath = path.join(workspace, "draft.txt")
    await writeFile(filePath, "draft-content")

    const decision = await authorizeZeroChatFilesystemPath({
      operation: "write",
      requestedPath: filePath,
      writeApprovalRequired: true,
      workspaceRoots: [workspace],
    })

    expect(decision).toMatchObject({
      allowed: true,
      operation: "write",
      approval: { required: true, reason: "write_requires_user_approval" },
    })
  })

  test("diagnostics mention paths and errors without raw file content", async () => {
    const workspace = await makeTempWorkspace()
    const rawContent = "raw bytes that must not be logged"
    const filePath = path.join(workspace, "private.txt")
    await writeFile(filePath, rawContent)

    const decision = await authorizeZeroChatFilesystemPath({
      operation: "read",
      requestedPath: filePath,
      resolvePath: async () => {
        throw new Error("realpath failed")
      },
      workspaceRoots: [workspace],
    })

    const diagnostic = buildZeroChatFilesystemDiagnostic(decision)

    expect(JSON.stringify(diagnostic)).toContain(filePath)
    expect(JSON.stringify(diagnostic)).toContain("realpath failed")
    expect(JSON.stringify(diagnostic)).not.toContain(rawContent)
  })
})
