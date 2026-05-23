// Krimto error type. The `code` maps to JSON-RPC custom codes / HTTP statuses in
// the transport layer (Build Spec Gap 16, v0.2).

export type KrimtoErrorCode =
  | "invalid_params"
  | "unauthorized"
  | "forbidden"
  | "not_found"
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
