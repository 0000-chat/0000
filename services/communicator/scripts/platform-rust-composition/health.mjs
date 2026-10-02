const defaultTimeoutMs = 5000;

export async function fetchWithDeadline(
  url,
  { shutdownSignal, timeoutMs = defaultTimeoutMs } = {},
) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (shutdownSignal?.aborted) abort();
  shutdownSignal?.addEventListener("abort", abort, { once: true });
  try {
    const response = await fetch(url, { signal: controller.signal });
    await response.arrayBuffer();
    return response;
  } finally {
    clearTimeout(timer);
    shutdownSignal?.removeEventListener("abort", abort);
  }
}
