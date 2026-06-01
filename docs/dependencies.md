# Dependencies

The bridge keeps direct dependencies intentionally small:

- `@modelcontextprotocol/sdk`: implements the local MCP server exposed to ACP
  runtimes so agents can use 0000 Chat tools.
- `zod`: validates MCP tool schemas and inputs.

## Why The Installed Tree Is Larger

The MCP SDK currently pulls in web-server, schema, event-stream, and auth
helpers such as Express, Hono, JOSE, and JSON schema packages. The bridge does
not use those packages as public HTTP servers, but they are transitive
dependencies of the SDK version in use.

## Maintenance

- Dependabot is enabled for npm dependencies and GitHub Actions.
- GitHub vulnerability alerts and automated security fixes are enabled.
- CI generates an SBOM artifact on each run.
- Before adding a new direct dependency, maintainers should document why the
  standard library or existing dependency set is not enough.

## Local Inspection

```bash
bun pm ls --all
bun run sbom
```

The SBOM is written to `sbom.cdx.json`.

