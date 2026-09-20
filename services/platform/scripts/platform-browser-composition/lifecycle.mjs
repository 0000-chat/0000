const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

export function processGroupExists(pid) {
  if (!pid) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function waitForGroupGone(pid, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!processGroupExists(pid)) return true;
    await sleep(25);
  }
  return !processGroupExists(pid);
}

export async function terminateProcessGroup(
  child,
  { termTimeoutMs = 8000, killTimeoutMs = 8000 } = {},
) {
  const pid = child?.pid;
  const result = {
    pid: pid ?? null,
    termSent: false,
    killSent: false,
    groupGone: true,
  };
  if (!pid || !processGroupExists(pid)) return result;

  try {
    process.kill(-pid, "SIGTERM");
    result.termSent = true;
  } catch {}
  if (await waitForGroupGone(pid, termTimeoutMs)) return result;

  if (processGroupExists(pid)) {
    try {
      process.kill(-pid, "SIGKILL");
      result.killSent = true;
    } catch {}
  }
  result.groupGone = await waitForGroupGone(pid, killTimeoutMs);
  return result;
}

export async function runBoundedCleanup(label, operation, timeoutMs = 8000) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label}_timeout`)),
          timeoutMs,
        );
      }),
    ]);
  } catch {
    throw new Error(`${label}_failed`);
  } finally {
    clearTimeout(timer);
  }
}

export function assertCloseCode(observation, expectedCode) {
  if (observation?.closeSeen !== true)
    throw new Error("realtime_close_event_missing");
  if (typeof observation.closeCode !== "number")
    throw new Error("realtime_close_code_missing");
  if (observation.closeCode !== expectedCode)
    throw new Error("realtime_close_code_unexpected");
}
