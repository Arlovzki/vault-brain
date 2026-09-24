import { timingSafeEqual } from "node:crypto";
import { CognitoJwtVerifier } from "aws-jwt-verify";

const BEARER = process.env.MCP_BEARER_TOKEN ?? "";

// Constant-time string compare. Without this, `===` short-circuits on the first
// differing byte, which is a timing oracle on the static bearer that grants full
// vault access. Returning early on a length mismatch leaks only the length.
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
const USER_POOL_ID = process.env.COGNITO_USER_POOL_ID ?? "";
const CLIENT_ID = process.env.COGNITO_CLIENT_ID ?? "";
export const ISSUER = process.env.COGNITO_ISSUER ?? "";
// Base URL of this API (e.g. https://xxxx.execute-api.region.amazonaws.com).
export const RESOURCE_URL = process.env.MCP_RESOURCE_URL ?? "";

const verifier =
  USER_POOL_ID.length > 0 && CLIENT_ID.length > 0
    ? CognitoJwtVerifier.create({
        userPoolId: USER_POOL_ID,
        tokenUse: "access",
        clientId: CLIENT_ID,
      })
    : null;

function bearerFrom(headers: Record<string, string | undefined> | undefined): string {
  const raw = headers?.authorization ?? headers?.Authorization ?? "";
  return raw.startsWith("Bearer ") ? raw.slice("Bearer ".length) : "";
}

/** True if the request carries a valid Cognito access token OR the static fallback bearer. */
export async function isAuthorized(
  headers: Record<string, string | undefined> | undefined,
): Promise<boolean> {
  const token = bearerFrom(headers);
  if (token.length === 0) return false;
  if (BEARER.length > 0 && safeEqual(token, BEARER)) return true;
  if (verifier) {
    try {
      await verifier.verify(token);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

/** RFC 9728 protected-resource metadata: tells clients which authorization server to use. */
export function protectedResourceMetadata() {
  return {
    resource: `${RESOURCE_URL}/mcp`,
    authorization_servers: [RESOURCE_URL],
    scopes_supported: ["openid", "email", "profile"],
    bearer_methods_supported: ["header"],
  };
}

/**
 * Authorization-server metadata: proxy Cognito's OIDC discovery but (a) strip
 * registration_endpoint so the caller uses our DCR bridge instead of Cognito's
 * (which does not exist), and (b) rewrite issuer to this resource so RFC 8414
 * issuer == location. Cognito's real authorize/token/jwks endpoints are preserved.
 */
// Cognito's discovery document is immutable for the pool's lifetime, so cache it
// across warm invocations and guard the outbound fetch: an unhandled throw here
// would turn the public discovery route into a 502 on any Cognito blip.
let cachedMeta: Record<string, unknown> | null = null;

export async function authorizationServerMetadata(): Promise<Record<string, unknown>> {
  if (!cachedMeta) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    try {
      const res = await fetch(`${ISSUER}/.well-known/openid-configuration`, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`discovery fetch ${res.status}`);
      cachedMeta = (await res.json()) as Record<string, unknown>;
    } finally {
      clearTimeout(t);
    }
  }
  const meta = { ...cachedMeta };
  delete meta["registration_endpoint"];
  meta["issuer"] = RESOURCE_URL;
  // Cognito supports PKCE S256 but omits it from its discovery document; strict
  // clients (ChatGPT's MCP connector among them) refuse an authorization server
  // that does not advertise it.
  meta["code_challenge_methods_supported"] = ["S256"];
  // The one registered client is public (no secret), so token requests carry no
  // client authentication; advertise "none" alongside what Cognito lists.
  meta["token_endpoint_auth_methods_supported"] = Array.from(
    new Set([
      ...((meta["token_endpoint_auth_methods_supported"] as string[] | undefined) ?? []),
      "none",
    ]),
  );
  return meta;
}

export const wwwAuthenticate = `Bearer resource_metadata="${RESOURCE_URL}/.well-known/oauth-protected-resource"`;
