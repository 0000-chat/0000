import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";

const here = dirname(fileURLToPath(import.meta.url));
const playwrightModule = resolve(
  here,
  "../../apps/control-plane/node_modules/@playwright/test/index.mjs",
);
const { chromium } = await import(playwrightModule);
const infoPath =
  process.env.T11_PLATFORM_INFO_PATH ??
  "/tmp/platform-t11-rust-composition.json";
const issuedPath =
  process.env.T11_ISSUED_SERVICE_PATH ??
  "/tmp/platform-t11-rust-composition-issued.json";
const info = JSON.parse(await readFile(infoPath, "utf8"));
const issued = JSON.parse(await readFile(issuedPath, "utf8"));
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ ignoreHTTPSErrors: true });
const page = await context.newPage();
page.setDefaultTimeout(25_000);

try {
  await page.goto(`${info.baseUrl}/login`, { waitUntil: "domcontentloaded" });
  const startResponse = await page.evaluate(async () => {
    const response = await fetch("/api/auth/sign-in/social", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "github",
        callbackURL: window.location.origin + "/account",
        disableRedirect: true,
      }),
    });
    return { status: response.status, body: await response.json() };
  });
  if (startResponse.status !== 200) {
    throw new Error(`Platform provider start failed: ${startResponse.status}`);
  }
  const state = new URL(startResponse.body.url).searchParams.get("state");
  if (!state) throw new Error("Platform provider state missing");
  await page.goto(
    `${info.baseUrl}/api/auth/callback/github?code=t11-rust-composition-revoke&state=${encodeURIComponent(state)}`,
    { waitUntil: "domcontentloaded" },
  );
  const response = await page.request.post(
    `${info.baseUrl}/api/account/service-principals/credentials/revoke`,
    {
      headers: {
        origin: info.baseUrl,
        "content-type": "application/json",
      },
      data: JSON.stringify({
        organizationId: issued.organizationId,
        subjectId: issued.subjectId,
        credentialId: issued.first.credentialId,
      }),
    },
  );
  const payload = await response.json();
  const revoked = response.ok() && payload.revoked === true;
  console.log(JSON.stringify({ status: response.status(), revoked }));
  if (!revoked) process.exitCode = 1;
} finally {
  await browser.close();
}
