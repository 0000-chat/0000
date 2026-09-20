# Managed msg rate-limit policy

This directory holds the proposed Cloud deployment input for msg's managed
Cloudflare Workers Rate Limit bindings. Cloud owns the deployment-time values;
the msg service owns the policy schema, validation, and conversion into
Wrangler bindings. The policy is read when the existing service Wrangler
wrapper prepares a deployment configuration. A running request does not make a
request to Cloud for quota decisions, and self-hosted msg does not need this
Cloud configuration.

`msg-rate-limit-policy.json` configures these service-owned budgets for each
60-second window:

| Binding | Limit |
| --- | ---: |
| `MSG_RATE_LIMIT_CREATION` | 6 |
| `MSG_RATE_LIMIT_READS` | 60 |
| `MSG_RATE_LIMIT_POSTS` | 20 |
| `MSG_RATE_LIMIT_LIVE` | 10 |

The four namespace IDs are proposed configuration values, not verified
deployed allocations. An operator must choose and reserve distinct IDs within
the target Cloudflare account deliberately. A namespace ID shares its counter
across the Workers that use it in that account. Cloudflare's rate-limit
semantics are location-local and eventually consistent, so these values do not
provide global billing or exact global accounting.

The policy contains no account credentials, provider tokens, or other secrets.
Actual account-specific IDs, credentials, and deployment inputs remain
untracked operator inputs. Do not put provider credentials in this file.

The existing msg wrapper consumes this file through the public msg parser and
binding builders. From the monorepo root, run the wrapper from the msg service
directory with an absolute policy path:

```sh
MONOREPO_ROOT=/absolute/path/to/0000
CLOUD_ROOT="$MONOREPO_ROOT/services/cloud"
(
  cd "$MONOREPO_ROOT/services/msg"
  MSG_RATE_LIMIT_POLICY_FILE="$CLOUD_ROOT/provisioning/platform-auth/msg-rate-limit-policy.json" \
    bun run wrangler types worker/worker-configuration.d.ts --include-runtime=true
)
```

To validate this artifact against the public service checkout from any working
directory, without copying its parser or adding a dependency to Cloud:

```sh
MONOREPO_ROOT=/absolute/path/to/0000
CLOUD_ROOT="$MONOREPO_ROOT/services/cloud"
bun "$CLOUD_ROOT/provisioning/platform-auth/verify-msg-rate-limit-policy.ts" \
  --0000-root "$MONOREPO_ROOT"
```

The verifier imports the public msg parser, Wrangler binding builder, and
Miniflare binding builder. It prints only the generated binding names and their
non-secret limits and periods. It requires the service root explicitly and has
no network or fallback checkout behavior. It can also prove rejection through
the same service validator by using a temporary malformed policy:

```sh
bad_policy=$(mktemp)
printf '%s\n' '{"creation":{"limit":0,"namespace_id":"1"},"reads":{"limit":60,"namespace_id":"2"},"posts":{"limit":20,"namespace_id":"3"},"live":{"limit":10,"namespace_id":"4"}}' > "$bad_policy"
if bun "$CLOUD_ROOT/provisioning/platform-auth/verify-msg-rate-limit-policy.ts" \
  --0000-root "$MONOREPO_ROOT" --policy "$bad_policy"; then
  echo "unexpected policy acceptance" >&2
  rm -f "$bad_policy"
  exit 1
fi
rm -f "$bad_policy"
```

This is managed-configuration preparation. It does not reserve IDs, publish a
Cloud repository, deploy a Worker, or prove hosted quota behavior. Platform's
T12 limits and Communicator configuration remain pending. The final T15 gate
still requires clean local sign-in, protected-consumer access, and persistence
across restart in the Workers/D1 composition.
