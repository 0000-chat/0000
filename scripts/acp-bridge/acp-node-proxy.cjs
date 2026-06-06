#!/usr/bin/env node
const { spawn } = require("node:child_process")

const [, , command, ...args] = process.argv

if (!command) {
  process.stderr.write("acp-node-proxy requires a command\n")
  process.exit(1)
}

const child = spawn(command, args, {
  cwd: process.cwd(),
  detached: process.platform !== "win32",
  env: process.env,
  stdio: ["pipe", "pipe", "pipe"],
})

process.stdin.pipe(child.stdin)
child.stdout.pipe(process.stdout)
child.stderr.pipe(process.stderr)

child.on("error", (error) => {
  process.stderr.write(`${error.message}\n`)
  process.exit(1)
})

child.on("exit", (code, signal) => process.exit(exitCodeForSignal(code, signal)))

process.on("SIGINT", () => terminateChild("SIGINT"))
process.on("SIGTERM", () => terminateChild("SIGTERM"))

function terminateChild(signal) {
  if (!child.pid) {
    process.exit(exitCodeForSignal(null, signal))
    return
  }

  try {
    if (process.platform === "win32") {
      child.kill(signal)
    } else {
      process.kill(-child.pid, signal)
    }
  } catch {
    // The child may have already exited between timeout settlement and cleanup.
  }

  setTimeout(() => {
    try {
      if (process.platform === "win32") {
        child.kill("SIGKILL")
      } else {
        process.kill(-child.pid, "SIGKILL")
      }
    } catch {
      // The child may have exited after the graceful signal.
    }
    process.exit(exitCodeForSignal(null, signal))
  }, 1000).unref()
}

function exitCodeForSignal(code, signal) {
  if (code !== null && code !== undefined) {
    return code
  }
  if (signal === "SIGINT") {
    return 130
  }
  if (signal === "SIGTERM") {
    return 143
  }
  return 1
}
