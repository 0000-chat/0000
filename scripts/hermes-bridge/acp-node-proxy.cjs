#!/usr/bin/env node
const { spawn } = require("node:child_process")

const [, , command, ...args] = process.argv

if (!command) {
  process.stderr.write("acp-node-proxy requires a command\n")
  process.exit(1)
}

const child = spawn(command, args, {
  cwd: process.cwd(),
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

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 0)
})

process.on("SIGINT", () => child.kill("SIGINT"))
process.on("SIGTERM", () => child.kill("SIGTERM"))
