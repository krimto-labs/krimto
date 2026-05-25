// Krimto error type. The `code` maps to JSON-RPC custom codes / HTTP statuses in
// the transport layer (Build Spec Gap 16, v0.2).

export type KrimtoErrorCode =
  | "invalid_params"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "rate_limited"
  | "internal";

export class KrimtoError extends Error {
  constructor(
    readonly code: KrimtoErrorCode,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "KrimtoError";
  }
}

// Gap 16 — error code mappings. JSON-RPC custom server codes (-32000..-32003) for the
// MCP surface; RFC 7231 statuses for the REST surface.
const JSON_RPC_CODES: Record<KrimtoErrorCode, number> = {
  invalid_params: -32602,
  unauthorized: -32000,
  forbidden: -32001,
  rate_limited: -32002,
  not_found: -32003,
  conflict: -32004,
  internal: -32603,
};

const HTTP_STATUS: Record<KrimtoErrorCode, number> = {
  invalid_params: 422,
  unauthorized: 401,
  forbidden: 403,
  rate_limited: 429,
  not_found: 404,
  conflict: 409,
  internal: 500,
};

export function jsonRpcCode(code: KrimtoErrorCode): number {
  return JSON_RPC_CODES[code];
}

export function httpStatus(code: KrimtoErrorCode): number {
  return HTTP_STATUS[code];
}

export function toJsonRpcError(error: KrimtoError): { code: number; message: string; data?: unknown } {
  return { code: jsonRpcCode(error.code), message: error.message, data: error.data };
}
