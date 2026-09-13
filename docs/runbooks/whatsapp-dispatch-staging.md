# WhatsApp text dispatch staging proof

The Worker adapter uses the private provider-neutral gateway route
`POST /v1/outbound/text`. It sends only after the durable dispatch lease is
claimed, the selected account route is re-read, and the account/chat
`message.send` grant and connected session are checked immediately before the
request. The request carries the original transaction ID and idempotency key;
it never selects a fallback account.

Run the controlled proof from the control-plane package with a sacrificial
linked account and a gateway test double:

```sh
cd apps/control-plane
WRANGLER_HOME="$PWD/../../node_modules/.cache/worker21-test-tmp/wrangler" \
TMPDIR="$PWD/../../node_modules/.cache/worker21-test-tmp" \
node_modules/.bin/vitest run --config vitest.worker.config.ts \
  worker/test/outbound/whatsapp-adapter.test.ts
```

The test double must return explicit Matrix, bridge, and provider evidence.
An `accepted` or `delivered` outcome without stage evidence is recorded as
uncertain, because an outcome alone does not prove WhatsApp delivery. Reuse of
the same transaction must use the same `outbound-<transaction_id>` idempotency
key.

This command is controlled proof only. It does not link a phone, send to a
real WhatsApp account, register a client, deploy a Worker, or establish live
provider capability. The account capability records remain `unverified` until
an approved sacrificial-account run against the pinned gateway is completed.
