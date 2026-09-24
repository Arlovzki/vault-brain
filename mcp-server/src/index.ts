import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from "aws-lambda";
import { tools, type Tool } from "./tools.js";
import {
  isAuthorized,
  protectedResourceMetadata,
  authorizationServerMetadata,
  wwwAuthenticate,
  RESOURCE_URL,
} from "./auth.js";
import { registerClient } from "./dcr.js";

// Stateless MCP request handler over JSON-RPC 2.0 for Lambda and API Gateway
// (Streamable HTTP), with Cognito OAuth discovery (RFC 9728) and a static bearer
// fallback. Vault content lives in S3, while Cognito stores authentication state.

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = { name: "vault-brain-server", version: "0.1.0" };
const allTools: Tool[] = tools;
const MAX_BATCH = 50;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}
type Id = string | number | null | undefined;

function ok(id: Id, result: unknown) {
  return { jsonrpc: "2.0" as const, id, result };
}
function fail(id: Id, code: number, message: string) {
  return { jsonrpc: "2.0" as const, id, error: { code, message } };
}

async function handleRpc(req: JsonRpcRequest): Promise<object | null> {
  // A syntactically valid body can still be the wrong shape (null, an array, or an
  // object without a string method). Reject with a JSON-RPC -32600 instead of letting
  // the deref below throw into an opaque 502.
  if (req === null || typeof req !== "object" || Array.isArray(req) || typeof req.method !== "string") {
    const id =
      req !== null && typeof req === "object" && !Array.isArray(req)
        ? ((req as { id?: Id }).id ?? null)
        : null;
    return fail(id, -32600, "Invalid Request");
  }
  const params = req.params ?? {};
  switch (req.method) {
    case "initialize":
      return ok(req.id, {
        protocolVersion:
          typeof params.protocolVersion === "string" ? params.protocolVersion : PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    case "notifications/initialized":
      return null;
    case "ping":
      return ok(req.id, {});
    case "tools/list":
      return ok(req.id, {
        tools: allTools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });
    case "tools/call": {
      const name = typeof params.name === "string" ? params.name : "";
      const tool: Tool | undefined = allTools.find((t) => t.name === name);
      if (!tool) return fail(req.id, -32602, `Unknown tool: ${name}`);
      const args = (params.arguments as Record<string, unknown> | undefined) ?? {};
      try {
        const text = await tool.handler(args);
        return ok(req.id, { content: [{ type: "text", text }] });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return ok(req.id, { content: [{ type: "text", text: `Error: ${msg}` }], isError: true });
      }
    }
    default:
      if (req.id === undefined || req.id === null) return null;
      return fail(req.id, -32601, `Method not found: ${req.method}`);
  }
}

const JSON_HEADERS = { "content-type": "application/json" };

function json(obj: unknown, statusCode = 200): APIGatewayProxyStructuredResultV2 {
  return { statusCode, headers: JSON_HEADERS, body: JSON.stringify(obj) };
}

async function handleMcp(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  if (!(await isAuthorized(event.headers))) {
    return {
      statusCode: 401,
      headers: { ...JSON_HEADERS, "www-authenticate": wwwAuthenticate },
      body: JSON.stringify({ error: "unauthorized" }),
    };
  }
  let payload: unknown;
  try {
    const raw =
      event.isBase64Encoded && event.body
        ? Buffer.from(event.body, "base64").toString("utf8")
        : (event.body ?? "");
    payload = JSON.parse(raw);
  } catch {
    return json(fail(null, -32700, "Parse error"), 400);
  }

  const accepted: APIGatewayProxyStructuredResultV2 = { statusCode: 202, body: "" };
  if (Array.isArray(payload)) {
    // Cap batch fan-out: an unbounded array would spawn one S3-hitting handler per
    // element from a single request. An empty batch is itself an invalid request.
    if (payload.length === 0) return json(fail(null, -32600, "Invalid Request"), 400);
    if (payload.length > MAX_BATCH) {
      return json(fail(null, -32600, `Batch too large (max ${MAX_BATCH})`), 400);
    }
    const results = (
      await Promise.all(payload.map((r) => handleRpc(r as JsonRpcRequest)))
    ).filter((r): r is object => r !== null);
    return results.length > 0 ? json(results) : accepted;
  }
  const result = await handleRpc(payload as JsonRpcRequest);
  return result === null ? accepted : json(result);
}

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> => {
  const path = event.rawPath ?? "/";
  const method = event.requestContext?.http?.method ?? "GET";

  // CORS preflight: the $default route sends OPTIONS here; 204 lets API Gateway's CORS
  // headers through (a 404 would fail the preflight and block the browser's real request).
  if (method === "OPTIONS") {
    return { statusCode: 204, body: "" };
  }

  // Public OAuth discovery routes (no auth).
  if (method === "GET" && path.startsWith("/.well-known/oauth-protected-resource")) {
    return json(protectedResourceMetadata());
  }
  if (method === "GET" && path === "/.well-known/oauth-authorization-server") {
    const meta = await authorizationServerMetadata();
    // Advertise our DCR bridge (Cognito cannot do RFC 7591 itself).
    meta["registration_endpoint"] = `${RESOURCE_URL}/register`;
    return json(meta);
  }

  // RFC 7591 dynamic client registration bridge (public, since clients register before auth).
  if (method === "POST" && path === "/register") {
    let body: Record<string, unknown> = {};
    try {
      const raw =
        event.isBase64Encoded && event.body
          ? Buffer.from(event.body, "base64").toString("utf8")
          : (event.body ?? "");
      body = JSON.parse(raw);
    } catch {
      /* empty/invalid body, so registerClient will reject */
    }
    const { status, json: j } = await registerClient(body);
    return json(j, status);
  }

  // The MCP endpoint (auth required).
  if (method === "POST") {
    return handleMcp(event);
  }

  return { statusCode: 404, body: "Not Found" };
};
