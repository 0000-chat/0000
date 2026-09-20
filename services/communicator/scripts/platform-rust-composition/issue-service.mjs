import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, writeFile } from "node:fs/promises";

const here = dirname(fileURLToPath(import.meta.url));
const playwrightModule = resolve(
  here,
  "../../apps/control-plane/node_modules/@playwright/test/index.mjs",
);
const { chromium } = await import(playwrightModule);
const infoPath =
  process.env.T11_PLATFORM_INFO_PATH ??
  "/tmp/platform-t11-rust-composition.json";
const outputPath =
  process.env.T11_ISSUED_SERVICE_PATH ??
  "/tmp/platform-t11-rust-composition-issued.json";
const info = JSON.parse(await readFile(infoPath, "utf8"));
const platformBaseUrl = info.baseUrl;
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ ignoreHTTPSErrors: true });
const page = await context.newPage();
page.setDefaultTimeout(25_000);

try {
  await page.goto(`${platformBaseUrl}/login`, {
    waitUntil: "domcontentloaded",
  });
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
  const providerUrl = new URL(startResponse.body.url);
  const state = providerUrl.searchParams.get("state");
  if (!state) throw new Error("Platform provider state missing");
  await page.goto(
    `${platformBaseUrl}/api/auth/callback/github?code=t11-rust-composition-service&state=${encodeURIComponent(state)}`,
    { waitUntil: "domcontentloaded" },
  );
  const me = await (await page.request.get(`${platformBaseUrl}/api/me`)).json();
  const organizationId = me.organizationId;
  if (typeof organizationId !== "string") {
    throw new Error("Platform organization missing");
  }

  const post = async (path, body) => {
    const response = await page.request.post(`${platformBaseUrl}${path}`, {
      headers: {
        origin: platformBaseUrl,
        "content-type": "application/json",
      },
      data: JSON.stringify(body),
    });
    const payload = await response.json();
    if (!response.ok()) {
      throw new Error(`${path} failed with status ${response.status()}`);
    }
    return payload;
  };

  const principal = await post("/api/account/service-principals", {
    organizationId,
    name: "T11 Rust composition service",
  });
  const grant = await post("/api/account/service-principals/grants", {
    organizationId,
    subjectId: principal.subjectId,
    serviceId: info.service.serviceId,
    capabilities: [
      "ingestion.write",
      "conversation.read",
      "connection.read",
      "message.send",
      "outbound.claim",
    ],
  });
  const issue = (name) =>
    post("/api/account/service-principals/credentials", {
      organizationId,
      subjectId: principal.subjectId,
      grantId: grant.id,
      serviceId: info.service.serviceId,
      capabilities: [
        "ingestion.write",
        "conversation.read",
        "connection.read",
        "message.send",
        "outbound.claim",
      ],
      lifetimeDays: 1,
      name,
    });
  const first = await issue("T11 Rust composition first");
  const second = await issue("T11 Rust composition replacement");

  await writeFile(
    outputPath,
    JSON.stringify(
      {
        authority: info.authority,
        audience: info.service.audience,
        serviceId: info.service.serviceId,
        serviceVerifier: info.service.verifier,
        organizationId,
        subjectId: principal.subjectId,
        grantId: grant.id,
        capabilities: first.capabilities,
        first,
        second,
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      issued: true,
      credentialCount: 2,
      accountSession: true,
      outputPath,
    }),
  );
} finally {
  await browser.close();
}
