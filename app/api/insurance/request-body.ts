// app/api/insurance/request-body.ts
//
// `req.json()` succeeds on `null`, on a scalar and on an array — all of them
// valid JSON, none of them a request body these routes can read properties
// from. A `null` body used to reach the first `body.foo` and throw a
// TypeError, and because the outer try/catch in every route was dead (the
// promise was returned before it settled) that throw escaped the handler
// entirely rather than becoming the 422 it should always have been.
import type { NextRequest } from "next/server"

export type JsonBodyResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; error: string }

export async function readJsonObject(req: NextRequest): Promise<JsonBodyResult> {
  let parsed: unknown
  try {
    parsed = await req.json()
  } catch {
    return { ok: false, error: "Invalid JSON body" }
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "Request body must be a JSON object" }
  }

  return { ok: true, body: parsed as Record<string, unknown> }
}
