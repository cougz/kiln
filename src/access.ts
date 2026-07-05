import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Env } from "./index";

/** Auth for /mcp — two accepted paths, first match wins:
 *
 *  1. Shared-secret header (Access "MCP server" app, Authentication type
 *     = Custom headers): Access's MCP portal performs managed OAuth with
 *     the user, enforces the Access policy, then calls this Worker with
 *     `x-kiln-mcp-key: <MCP_SHARED_SECRET>`. Identity (when Access
 *     forwards it) is read from cf-access-authenticated-user-email.
 *
 *  2. Cf-Access-Jwt-Assertion JWT (self-hosted Access app pattern):
 *     needs TEAM_DOMAIN + POLICY_AUD. Kept for a future custom-domain
 *     deployment — workers.dev hostnames can't be self-hosted apps, and
 *     the MCP-server app type exposes no AUD tag.
 */

export interface AccessClaims {
  sub: string;
  email?: string;
}

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
let jwksTeam = "";

/** Decode a JWT payload WITHOUT verification — for failure logging only. */
function unsafeClaims(token: string): Record<string, unknown> {
  try {
    const b64 = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(b64));
  } catch {
    return {};
  }
}

async function logReject(env: Env, req: Request, reason: string, token?: string | null) {
  try {
    const c = token ? unsafeClaims(token) : {};
    console.log(
      `mcp auth reject: ${reason} | iss=${c.iss} aud=${JSON.stringify(c.aud)} ` +
        `sub=${c.sub} ua=${req.headers.get("user-agent")}`,
    );
    await env.DB.prepare(
      "INSERT INTO auth_log (reason, iss, aud, sub, email, ua) VALUES (?, ?, ?, ?, ?, ?)",
    )
      .bind(
        reason,
        (c.iss as string) ?? null,
        JSON.stringify(c.aud ?? null),
        (c.sub as string) ?? null,
        (c.email as string) ?? null,
        req.headers.get("user-agent"),
      )
      .run();
  } catch {}
}

function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

export async function verifyMcpAuth(
  req: Request,
  env: Env,
): Promise<AccessClaims | Response> {
  const sharedConfigured = Boolean(env.MCP_SHARED_SECRET);
  const jwtConfigured = Boolean(env.TEAM_DOMAIN && env.POLICY_AUD);

  if (!sharedConfigured && !jwtConfigured) {
    return new Response(
      "MCP auth not configured: set the MCP_SHARED_SECRET secret (Access " +
        "custom-headers upstream auth) or TEAM_DOMAIN + POLICY_AUD vars",
      { status: 503 },
    );
  }

  const key = req.headers.get("x-kiln-mcp-key");
  if (sharedConfigured && key) {
    if (timingSafeEqual(key, env.MCP_SHARED_SECRET as string)) {
      const email =
        req.headers.get("cf-access-authenticated-user-email") ?? undefined;
      return { sub: email ?? "access-portal", email };
    }
    await logReject(env, req, "bad shared key");
    return new Response("invalid MCP key", { status: 403 });
  }

  const bearer = req.headers.get("authorization");
  const token =
    req.headers.get("cf-access-jwt-assertion") ??
    (bearer?.startsWith("Bearer ") ? bearer.slice(7) : null);
  if (jwtConfigured && token) {
    if (!jwks || jwksTeam !== env.TEAM_DOMAIN) {
      jwks = createRemoteJWKSet(
        new URL(`https://${env.TEAM_DOMAIN}/cdn-cgi/access/certs`),
      );
      jwksTeam = env.TEAM_DOMAIN as string;
    }
    try {
      const { payload } = await jwtVerify(token, jwks, {
        issuer: `https://${env.TEAM_DOMAIN}`,
        audience: env.POLICY_AUD,
      });
      return { sub: String(payload.sub), email: payload.email as string | undefined };
    } catch (err) {
      await logReject(env, req, `jwt verify failed: ${err}`, token);
      return new Response(`invalid Access JWT: ${err}`, { status: 403 });
    }
  }

  // RFC 9728: point OAuth-capable MCP clients at the protected-resource
  // metadata so they can discover Access as the authorization server.
  await logReject(env, req, "no credentials", token);
  const origin = new URL(req.url).origin;
  return new Response(
    "unauthorized: authenticate via OAuth (see WWW-Authenticate) or the " +
      "Access MCP portal",
    {
      status: 401,
      headers: {
        "www-authenticate": `Bearer realm="kiln", resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
      },
    },
  );
}
