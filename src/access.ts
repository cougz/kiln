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
    return new Response("invalid MCP key", { status: 403 });
  }

  const token = req.headers.get("cf-access-jwt-assertion");
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
      return new Response(`invalid Access JWT: ${err}`, { status: 403 });
    }
  }

  return new Response(
    "unauthorized: connect through the Access MCP portal (or supply a valid " +
      "Access JWT)",
    { status: 401 },
  );
}
