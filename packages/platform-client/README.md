# Platform client transport

The shared Platform and guest clients use one bounded JSON transport. Each
client accepts an optional `timeoutMs` request deadline. The value must be a
finite integer from `1` through `60000` milliseconds; omitted values default to
`10000` milliseconds. The deadline covers the fetch and response body parsing.

The transport passes an `AbortSignal` to `fetch` and uses manual redirect mode,
rejecting every redirect response before its body is trusted, so credentials
and service or guest control material are not forwarded through redirects. A
timeout or transport/body failure returns
`authority_unavailable`. Guest mutations are not retried when their response
deadline expires because the server may already have committed the operation.
