import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflowPath = path.join(root, ".github/workflows/deploy-gateway.yml");
const workflow = fs.readFileSync(workflowPath, "utf8");
const errors = [];

function expect(condition, message) {
  if (!condition) errors.push(message);
}

expect(!/^\s+push:\s*$/m.test(workflow), "Gateway production workflow must not trigger on push");
expect(/^\s+workflow_dispatch:\s*$/m.test(workflow), "Gateway production workflow must retain workflow_dispatch");
expect(/^\s+confirm_production_deploy:\s*$/m.test(workflow), "Gateway production workflow must require a confirmation input");
expect(/description:\s*["']Type DEPLOY_GATEWAY to authorize the production deploy\.["']/.test(workflow), "Gateway production workflow must describe the exact confirmation token");
expect(/^\s+required:\s+true\s*$/m.test(workflow), "Gateway production confirmation input must be required");
expect(/^\s+type:\s+string\s*$/m.test(workflow), "Gateway production confirmation input must be a string");
expect(
  workflow.includes(
    "github.actor == 'donmasakayan' && github.triggering_actor == 'donmasakayan' && inputs.confirm_production_deploy == 'DEPLOY_GATEWAY'"
  ),
  "Gateway production job must require the owner as both actor and triggering actor plus exact confirmation"
);

if (errors.length > 0) {
  console.error(errors.map((error) => `- ${error}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log("Gateway production workflow safety check passed");
}
