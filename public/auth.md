# kiln Authentication

kiln 0.3.0 uses one deployment-managed API key. There is no OAuth provider,
authorization-code flow, device flow, dynamic client registration, user login,
token refresh, scope model, or token issuance endpoint.

## What Requires a Key

Public REST and MCP reads need no credentials. A key is required to:

- Create a project or edit its public metadata.
- Add source versions or parameters.
- Create or replace project documents.
- Queue, retry, or cancel builds.
- Run geometry measurement or target checks.

The key grants all write and compute capabilities. kiln 0.3.0 does not issue
different roles or per-project keys.

## Send the Key

Use either header over HTTPS:

```http
Authorization: Bearer <key>
```

```http
X-Kiln-API-Key: <key>
```

If both headers are sent, they must contain the same key. Do not put the key in
a URL or query string.

REST example:

```sh
curl --fail-with-body -X PATCH \
  -H "Authorization: Bearer ${KILN_API_KEY}" \
  -H 'Content-Type: application/json' \
  -d '{"description":"Updated public description"}' \
  https://kiln.timcf.workers.dev/api/projects/example-project
```

MCP clients should configure one of the same headers on the absolute endpoint:

```text
https://kiln.timcf.workers.dev/mcp
```

The Worker validates the key on every protected MCP `tools/call` request. An
authenticated initialization does not authorize later calls without the key,
and rotating the Worker secret invalidates the old key for existing sessions.

The browser application accepts a key for protected authoring. It stores the
value only in `sessionStorage` for the current tab and sends it as Bearer
authorization. Clear it on shared machines and close the tab after use.

## Obtain or Configure a Key

The public service does not expose self-service key creation. Obtain the key
from the deployment operator through a secret-management channel.

Operators configure production with:

```sh
npx wrangler secret put KILN_API_KEY
```

For local development, put `KILN_API_KEY` in the git-ignored `.dev.vars` file.
Use a different value from production.

If the Worker secret is absent, protected operations remain locked and return
`401`; they do not become open. `/api/health` reports the boolean
`write_auth_configured` so operators can detect this state without revealing
the key.

## Failures

- `401 AUTH_REQUIRED` means the key was absent, malformed, empty, mismatched,
  or invalid. REST includes `WWW-Authenticate: Bearer`.
- `403 INSUFFICIENT_PERMISSION` means an authenticated context lacks the
  requested capability. The current shared deployment key grants both
  capabilities, but clients should still handle this status.
- `429 RATE_LIMITED` means the key identity exceeded a mutation or compute
  window. REST includes `Retry-After`.

Never log the key or include it in bug reports. Request and error IDs are safe
correlation values; authorization headers are not.

## Rotation

Version 0.3.0 supports one active key, without an overlap window. Coordinate
writers, replace the Worker secret, verify that the old value receives `401`,
then update clients through their secret stores. Rotate immediately after any
suspected disclosure.

## Public Data Is Still Public

Authentication protects changes and compute consumption, not confidentiality.
Project metadata, all source history, parameters, documents, build settings,
logs and reports, manifests, and artifacts are readable without a key. Never
submit a credential, private design, personal data, or regulated information.
