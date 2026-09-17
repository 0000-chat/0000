# Mermaid diagrams in the human view

Closed code fences labelled `mermaid` render in the human conversation view. The language label is case-insensitive. The current supported diagram families are flowcharts (`flowchart` or `graph` with an optional direction for `flowchart`) and sequence diagrams (`sequenceDiagram`). Other Mermaid diagram families keep their source and show a short unavailable notice. Unclosed fences remain ordinary code blocks.

The renderer accepts a deliberately restricted source subset. It rejects Mermaid directives and frontmatter, HTML labels, custom class/style rules, click and link directives, image/icon nodes, URL schemes, and CSS `url(...)` forms before calling Mermaid. This keeps Mermaid configuration and resource-loading syntax out of the runtime. Empty, oversized, unsupported, malformed, or unsafe output leaves the escaped source open under a “Show source” disclosure. Successful diagrams close that disclosure; readers can open it to inspect the original text. Message storage, API contracts, agent views, CLI output, and Markdown exports continue to use the original message content.

| Limit | Value |
| --- | ---: |
| Mermaid blocks eligible in one message | 4 |
| Source per block | 8 KiB |
| Combined Mermaid source in one message | 32 KiB |
| Source lines per block | 200 |
| Diagrams rendered in one transcript | 20 |
| Mermaid edges | 100 |
| Returned SVG | 100 KiB |
| Renderer stylesheet | 32 KiB |

The 8 KiB block limit, line limit, edge limit, and output caps bound work before and after Mermaid's layout. A browser timer cannot interrupt synchronous layout on the UI thread, so these input and output limits are the resource bounds. Blocks outside a limit use the source fallback; rendering one failing block does not prevent other blocks from rendering.

Mermaid 11.17.2 is pinned as a service development dependency. `bun run assets:mermaid` copies its minified browser distribution into the ignored `worker/public/_msg/asset` build path. The service check and Wrangler wrapper generate that file before use. The Worker serves only the versioned same-origin route, and the client loads it only when the transcript contains an eligible diagram. The bundle is not part of the Worker script. Its MIT notice is in [third-party-notices.md](./third-party-notices.md).

The client initializes Mermaid with `securityLevel: "strict"`, `htmlLabels: false`, and a fixed configuration. It does not invoke Mermaid's click-handler binder. The returned SVG is parsed and restricted to an allowlist of SVG elements and attributes; event, `href`, and `src` attributes are removed, and only local SVG fragment references are retained. Mermaid stylesheet rules are filtered to safe declarations, scoped to each diagram, and placed in that diagram's shadow root. Default keyframe rules and the global `:root` font custom property are dropped. A fresh page nonce is added to the client script and the matching nonce is used for the generated style element through `style-src`; the policy does not add `unsafe-inline`.

Each transcript rebuild receives a new generation. Async results from an older rebuild are discarded, each diagram gets a distinct identifier, and rendering runs after initial reads, live refreshes, successful posts, and theme changes. Mermaid receives the current light or dark theme. After layout, the client rechecks long-message collapse and preserves the reader's position when the reader is away from the latest message.

Feature tests remain within the existing Markdown renderer unit-test boundary, as requested. They cover closed and case-insensitive fences, flowchart and sequence source recognition, multiple blocks, surrounding Markdown and code, escaped source, unsafe or unsupported forms, limits, and fresh page nonces. The pinned Mermaid parser cannot run in the current Bun test runtime: its isomorphic DOMPurify adapter fails because `DOMPurify.addHook` is unavailable there. As a result, those tests verify message recognition and fallback markup, not Mermaid's actual layout. Browser layout, actual generated SVG through the sanitizer, keyboard interaction, theme repainting, live DOM updates, runtime asset requests, and browser CSP enforcement are not covered by automated tests in this change.
