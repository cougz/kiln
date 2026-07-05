import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Env } from "./index";

/** Cloudflare Access JWT validation (customer-managed custom MCP server
 *  pattern): Access is the OAuth authorization server; this Worker only
 *  verifies the Cf-Access-Jwt-Assertion it injects — signature against
 *  the team JWKS, issuer, and the Access application's AUD tag. */

export interface AccessClaims {
  sub: string;
  email?: string;
}

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
let jwksTeam = "";

export async function verifyAccess(
  req: Request,
  env: Env,
): Promise<AccessClaims | Response> {
  if (!env.TEAM_DOMAIN || !env.POLICY_AUD) {
    return new Response(
      "MCP auth not configured: set TEAM_DOMAIN and POLICY_AUD vars",
      { status: 503 },
    );
  }
  const token = req.headers.get("cf-access-jwt-assertion");
  if (!token) {
    return new Response("missing Cf-Access-Jwt-Assertion (connect via Access)", {
      status: 401,
    });
  }
  if (!jwks || jwksTeam !== env.TEAM_DOMAIN) {
    jwks = createRemoteJWKSet(
      new URL(`https://${env.TEAM_DOMAIN}/cdn-cgi/access/certs`),
    );
    jwksTeam = env.TEAM_DOMAIN;
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
