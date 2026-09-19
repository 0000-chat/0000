# Matrix gateway package

This directory contains the reviewable systemd package for the receive-only
Matrix gateway. Install the compiled `communicator-matrix-gateway` binary at
`/usr/local/bin/communicator-matrix-gateway`, copy `config.example.json` to
`/etc/communicator/matrix-gateway/config.json`, and replace only its endpoint,
identity, and protected-file paths with deployment values. Install the unit as
`/etc/systemd/system/communicator-matrix-gateway.service`.

Create the configured state and Matrix-store directories before starting the
receive-only unit. If the optional `provisioning` block is present, install
`communicator-matrix-provisioning.service` as a separate private-network
unit; it exposes only the authenticated gateway listener and never a public
Caddy route. Protected secret files must be provisioned separately with the
ownership and permissions required by the existing secret loader. Provision the
ingestion service credential for the daemon and, when provisioning is enabled,
the separate outbound authority credential. Keep the gateway shared secret as
the Worker-to-gateway transport credential; it is not a substitute for either
Platform service credential. The package contains no secret values, runtime
database, Matrix session, or generated SDK store.

An ingestion `401` stops the daemon with exit code `78`. The shipped systemd
unit marks that code as operator-controlled and does not restart it; replace
the protected credential and explicitly restart the unit after investigation.
Configure an equivalent no-automatic-restart policy for other supervisors.

Run the local review and health gates in
`docs/runbooks/matrix-gateway-operations.md` before enabling the unit. The
unit is a package contract only; this change does not activate a production
service or send live messages.
