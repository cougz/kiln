# kiln Authentication

kiln supports Cloudflare Access for browser sessions and Managed OAuth for MCP
clients. Both flows use the same Access policies and upstream identity provider.
The Worker validates the signed Access application JWT before granting write or
compute permissions.

## Browser Flow

Protect the browser hostname with a Cloudflare Access self-hosted application.
An unauthenticated browser is redirected to the Cloudflare Access team domain,
which redirects to the configured SSO provider. After login, Access stores the
application session in an HTTP-only `CF_Authorization` cookie.

The browser application does not handle OAuth access tokens or store credentials
in JavaScript. Same-origin API requests carry the Access cookie automatically.
Cloudflare verifies the cookie and forwards a signed `Cf-Access-Jwt-Assertion`
header to the Worker. The Worker validates its signature, issuer, audience, and
expiry before trusting the user identity.

Use `/cdn-cgi/access/logout` to end the Access browser session. `GET
/api/session` returns a sanitized view of the current authentication method,
email when available, and write/compute permissions.

## MCP Managed OAuth Flow

Enable Managed OAuth on the Access application protecting the MCP endpoint.
Compatible clients discover Cloudflare's authorization server through the
`WWW-Authenticate` protected-resource metadata, dynamically register when
allowed, and complete authorization code with PKCE. The user signs in through
the same Access team domain and SSO provider as the browser application.

Managed OAuth requires an OAuth client that supports RFC 8707 resource
indicators. Cloudflare issues an opaque access token to the client. The Worker
does not decode that token; Access validates it and forwards the same signed
`Cf-Access-Jwt-Assertion` used for browser sessions.

Recommended Managed OAuth settings are:

- Access token lifetime of 5 to 15 minutes.
- Grant session duration of one to two weeks.
- Localhost and loopback redirects only when desktop clients require them.
- Explicit HTTPS redirect URI patterns for hosted clients.
- Dynamic client registration only when required by supported clients.

Use an Access service token for unattended automation where no user can
complete an interactive login.

## Worker Configuration

Set both non-secret Worker variables:

```dotenv
CF_ACCESS_TEAM_DOMAIN=https://your-team.cloudflareaccess.com
CF_ACCESS_AUD=your-access-application-audience
```

`CF_ACCESS_AUD` accepts a comma-separated list when the same Worker serves
separate browser and MCP Access applications. The Worker accepts only RS256
application JWTs issued by `CF_ACCESS_TEAM_DOMAIN` for one of those audiences.
It uses the Access `sub` claim as the stable user identity. Service-token
assertions use their `common_name` identity.

Configure these values in the Cloudflare dashboard or the deployment's Wrangler
environment. They are deployment identifiers, not credentials, but they must
match the Access applications exactly. `/api/health` reports
`access_auth_configured` and the combined `write_auth_configured` state.

The Worker must still validate Access JWTs even though Access runs at the edge.
This prevents a direct or accidentally unprotected route from spoofing the
`Cf-Access-Jwt-Assertion` header. Disable the default `workers.dev` route when
custom domains are the only intended entry points, or attach the Access
application directly to the Worker so every route is protected.

## Recommended Hostnames

Use separate hostnames when browser and MCP policies or session controls differ:

| Host | Access application | Purpose |
|---|---|---|
| `studio.example.com` | Self-hosted | Browser workspace and same-origin REST API |
| `mcp.example.com/mcp` | MCP server with Managed OAuth | Interactive MCP clients |
| `kiln.example.com` | Optional public hostname | Public gallery and artifacts |

Access applications match hostnames and paths, not HTTP methods. To preserve
public reads while requiring Access for writes, use separate public and studio
hostnames or keep authorization in the Worker. One multi-domain Access
application can serve both browser and MCP traffic when they intentionally share
the same policies.

## API-Key Transition

`KILN_API_KEY` remains an optional compatibility and local-development fallback
for existing REST and MCP automation. Send it in either header:

```http
Authorization: Bearer <key>
```

```http
X-Kiln-API-Key: <key>
```

The browser application no longer accepts or stores this key. New interactive
clients should use Cloudflare Access. Do not put any credential in a URL,
project, source file, parameter, document, log, or artifact.

## Origin and Permission Checks

An authenticated Access identity currently receives both write and compute
permissions after it passes the Access application policy. API-key fallback
authentication grants the same capabilities. kiln does not yet implement
project-specific roles.

Access-authenticated REST writes with a browser `Origin` header must be
same-origin. MCP retains its explicit browser-origin allowlist. Requests without
valid authentication receive `401 AUTH_REQUIRED`; valid identities without a
required capability receive `403 INSUFFICIENT_PERMISSION`.

## Public Data Boundary

Authentication protects changes and compute consumption, not confidentiality on
the public hostname. Project metadata, all source history, parameters, documents,
build settings, logs and reports, manifests, and artifacts remain public unless
the entire read surface is placed behind Access. Never submit credentials,
private designs, personal data, or regulated information.
