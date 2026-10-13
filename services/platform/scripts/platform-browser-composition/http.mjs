const defaultTimeoutMs = 5000;

export async function fetchBodyWithDeadline(
  input,
  init = {},
  { shutdownSignal, timeoutMs = defaultTimeoutMs } = {},
) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (shutdownSignal?.aborted) abort();
  shutdownSignal?.addEventListener("abort", abort, { once: true });
  try {
    const response = await fetch(input, {
      ...init,
      signal: controller.signal,
    });
    const body = await response.arrayBuffer();
    return { response, body };
  } finally {
    clearTimeout(timer);
    shutdownSignal?.removeEventListener("abort", abort);
  }
}

export async function fetchJsonWithDeadline(input, init = {}, options = {}) {
  const { response, body } = await fetchBodyWithDeadline(input, init, options);
  const text = new TextDecoder().decode(body);
  if (text.length === 0) return { response, body: {} };
  try {
    return { response, body: JSON.parse(text) };
  } catch {
    return { response, body: {} };
  }
}
