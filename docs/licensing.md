# Licensing map

The public `0000` monorepo uses package-level licensing. The machine-readable
map is [`licenses/package-license-map.json`](../licenses/package-license-map.json),
and the root copies of the approved license texts are
[`LICENSE-AGPL-3.0.txt`](../LICENSE-AGPL-3.0.txt) and
[`LICENSE-APACHE-2.0.txt`](../LICENSE-APACHE-2.0.txt).

Deployable services, backend services, orchestration, the normal product UI,
and first-party agents use AGPL-3.0-only. SDKs, protocols, schemas, clients,
connector kits, examples, and broadly reusable integration packages use
Apache-2.0. Each discovered package manifest declares the same SPDX
identifier as the map. The repository check rejects an absent, unsupported, or
inconsistent declaration and verifies the canonical text digests.

## Reviewed legacy exception

`@0000chat/msg` at `services/msg/cli` remains MIT. It is an existing published
CLI whose package manifest and local `LICENSE` already declare MIT. The map
records this as a reviewed `legacy-exception` with a
`preserve-without-relicensing` decision. This slice does not relicense it and
does not assert copyright authority that has not been verified. A future
migration requires an explicit rights and compatibility decision before the
exception can change.

The temporary `services/cloud` workspace is private operations material and is
excluded from the public map while the public-boundary migration removes it.
It must not become a public distributable package by adding a license entry.

The AGPL text was copied from the GNU-hosted official text at
<https://www.gnu.org/licenses/agpl-3.0.txt>. The Apache text was copied from
the local system's `/usr/share/common-licenses/Apache-2.0` copy and is the
Apache License 2.0 text published at
<https://www.apache.org/licenses/LICENSE-2.0.txt>. The map pins SHA-256
digests for both copies so a modified legal text fails the check.
