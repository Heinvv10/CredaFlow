export type ChangeRequestErrorCode =
  | "UNKNOWN_KIND"
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "SELF_APPROVAL"
  | "MAKER_ACCOUNT_CONTROLLED"
  | "NOT_MAKER"
  | "WRONG_STATE"
  | "STALE"
  | "TOTP_REQUIRED"
  | "INVALID_PAYLOAD"

const STATUS: Record<ChangeRequestErrorCode, number> = {
  UNKNOWN_KIND: 400,
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  SELF_APPROVAL: 403,
  MAKER_ACCOUNT_CONTROLLED: 403,
  NOT_MAKER: 403,
  WRONG_STATE: 409,
  STALE: 409,
  TOTP_REQUIRED: 403,
  INVALID_PAYLOAD: 422,
}

/** A refusal the caller can show; `status` is the HTTP status a route should answer. */
export class ChangeRequestError extends Error {
  readonly status: number
  constructor(readonly code: ChangeRequestErrorCode, message: string, readonly problems: readonly string[] = []) {
    super(message)
    this.name = "ChangeRequestError"
    this.status = STATUS[code]
  }
}

/** What a handler's parse/verify throws: every problem found, one line each. */
export class InvalidPayloadError extends ChangeRequestError {
  constructor(problems: readonly string[]) {
    super("INVALID_PAYLOAD", problems[0] ?? "Invalid change", problems)
  }
}
