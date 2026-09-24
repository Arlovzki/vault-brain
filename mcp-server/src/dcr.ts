import {
  CognitoIdentityProviderClient,
  DescribeUserPoolClientCommand,
  UpdateUserPoolClientCommand,
} from "@aws-sdk/client-cognito-identity-provider";

// RFC 7591 Dynamic Client Registration bridge for Cognito.
// Cognito has no native DCR, so compatible MCP clients cannot self-register directly.
// Rather than mint a new client (which would force accepting any client id), we return the
// ONE existing public client and add the caller's redirect_uris to it. Token validation
// stays strict against that single known client id.

const USER_POOL_ID = process.env.COGNITO_USER_POOL_ID ?? "";
const CLIENT_ID = process.env.COGNITO_CLIENT_ID ?? "";
const cognito = new CognitoIdentityProviderClient({});

// This endpoint is unauthenticated (clients register before they can get a token),
// so without an allowlist anyone with the URL could add their own callback to the
// one shared OAuth client and phish an auth code for the whole vault. Only accept
// redirect URIs that belong to a known MCP host (or localhost, for local testing),
// and cap how many can accumulate on the client so it cannot be flooded past
// Cognito's callback-URL limit.
const ALLOWED_REDIRECT_HOSTS = [
  "claude.ai",
  "claude.com",
  "anthropic.com",
  "chatgpt.com",
  "openai.com",
];
const MAX_CALLBACK_URLS = 20;
const MAX_REDIRECT_URIS_PER_REQUEST = 5;
const MAX_REDIRECT_URI_LENGTH = 2048;

function isAllowedRedirectUri(u: string): boolean {
  let url: URL;
  try {
    url = new URL(u);
  } catch {
    return false;
  }
  if (url.username || url.password || url.hash) return false;
  const host = url.hostname.toLowerCase();
  const isLocal = host === "localhost" || host === "127.0.0.1";
  if (isLocal) return url.protocol === "http:" || url.protocol === "https:";
  if (url.protocol !== "https:") return false;
  return ALLOWED_REDIRECT_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

interface RegistrationRequest {
  redirect_uris?: unknown;
}

export async function registerClient(
  body: RegistrationRequest,
): Promise<{ status: number; json: Record<string, unknown> }> {
  if (!Array.isArray(body.redirect_uris) || body.redirect_uris.length === 0) {
    return {
      status: 400,
      json: { error: "invalid_redirect_uri", error_description: "redirect_uris is required" },
    };
  }

  if (body.redirect_uris.length > MAX_REDIRECT_URIS_PER_REQUEST) {
    return {
      status: 400,
      json: {
        error: "invalid_redirect_uri",
        error_description: `at most ${MAX_REDIRECT_URIS_PER_REQUEST} redirect_uris can be registered at once`,
      },
    };
  }

  if (
    body.redirect_uris.some(
      (uri) =>
        typeof uri !== "string" ||
        uri.length === 0 ||
        uri.length > MAX_REDIRECT_URI_LENGTH ||
        uri !== uri.trim() ||
        !isAllowedRedirectUri(uri),
    )
  ) {
    return {
      status: 400,
      json: {
        error: "invalid_redirect_uri",
        error_description: `every redirect URI must be https on an allowed host (${ALLOWED_REDIRECT_HOSTS.join(", ")}) or use http/https on localhost; credentials and fragments are not allowed`,
      },
    };
  }
  const redirectUris = Array.from(new Set(body.redirect_uris as string[]));

  const desc = await cognito.send(
    new DescribeUserPoolClientCommand({ UserPoolId: USER_POOL_ID, ClientId: CLIENT_ID }),
  );
  const c = desc.UserPoolClient ?? {};
  const merged = Array.from(new Set([...(c.CallbackURLs ?? []), ...redirectUris]));
  if (merged.length > MAX_CALLBACK_URLS) {
    return {
      status: 400,
      json: {
        error: "invalid_redirect_uri",
        error_description: "too many registered callback URLs; contact the vault owner",
      },
    };
  }

  // Re-supply the full config; UpdateUserPoolClient resets omitted fields.
  await cognito.send(
    new UpdateUserPoolClientCommand({
      UserPoolId: USER_POOL_ID,
      ClientId: CLIENT_ID,
      ClientName: c.ClientName,
      CallbackURLs: merged,
      LogoutURLs: c.LogoutURLs,
      AllowedOAuthFlows: c.AllowedOAuthFlows,
      AllowedOAuthScopes: c.AllowedOAuthScopes,
      AllowedOAuthFlowsUserPoolClient: c.AllowedOAuthFlowsUserPoolClient,
      SupportedIdentityProviders: c.SupportedIdentityProviders,
      ExplicitAuthFlows: c.ExplicitAuthFlows,
      RefreshTokenValidity: c.RefreshTokenValidity,
      AccessTokenValidity: c.AccessTokenValidity,
      IdTokenValidity: c.IdTokenValidity,
      TokenValidityUnits: c.TokenValidityUnits,
      ReadAttributes: c.ReadAttributes,
      WriteAttributes: c.WriteAttributes,
      DefaultRedirectURI: c.DefaultRedirectURI,
      AnalyticsConfiguration: c.AnalyticsConfiguration,
      PreventUserExistenceErrors: c.PreventUserExistenceErrors,
      EnableTokenRevocation: c.EnableTokenRevocation,
      EnablePropagateAdditionalUserContextData: c.EnablePropagateAdditionalUserContextData,
      AuthSessionValidity: c.AuthSessionValidity,
      RefreshTokenRotation: c.RefreshTokenRotation,
    }),
  );

  return {
    status: 201,
    json: {
      client_id: CLIENT_ID,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: merged,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: "openid email profile",
    },
  };
}
