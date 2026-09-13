# Matrix gateway package

This directory contains the reviewable systemd package for the receive-only
Matrix gateway. Install the compiled `communicator-matrix-gateway` binary at
`/usr/local/bin/communicator-matrix-gateway`, copy `config.example.json` to
`/etc/communicator/matrix-gateway/config.json`, and replace only its endpoint,
identity, and protected-file paths with deployment values. Install the unit as
`/etc/systemd/system/communicator-matrix-gateway.service`.

Create the configured state and Matrix-store directories before starting the
unit. Protected secret files must be provisioned separately with the ownership
and permissions required by the existing secret loader. The package contains
no secret values, runtime database, Matrix session, or generated SDK store.

Run the local review and health gates in
`docs/runbooks/matrix-gateway-operations.md` before enabling the unit. The
unit is a package contract only; this change does not activate a production
service or send live messages.
