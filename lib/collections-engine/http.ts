import { NextResponse } from "next/server"
import { CollectionProviderError } from "@/lib/integrations/collections/types"
import { MandateError, type MandateErrorCode } from "./mandates"

const STATUS: Record<MandateErrorCode, number> = {
  FLAG_OFF: 409,
  NOT_FOUND: 404,
  NOT_ELIGIBLE: 422,
  INVALID_TERMS: 422,
  LIVE_MANDATE_EXISTS: 409,
  INVALID_STATE: 409,
}

/** Maps the engine's own errors to a response; null for anything else (the caller rethrows). */
export function mandateErrorResponse(error: unknown): NextResponse | null {
  if (error instanceof MandateError) {
    return NextResponse.json({ error: error.message, code: error.code }, { status: STATUS[error.code] })
  }
  if (error instanceof CollectionProviderError) {
    // The provider's refusal, surfaced to staff rather than retried silently (lib/integrations/.claude.md).
    return NextResponse.json({ error: `Collection provider: ${error.message}`, code: error.code }, { status: 502 })
  }
  return null
}
