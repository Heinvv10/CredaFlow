/**
 * How a dealer portal route answers a dealer-domain result (lib/dealer/*):
 * a refusal is `{ error }` at its status; an input problem is 400 with the
 * field errors; a capture is 201 with the new row's id and nothing else.
 */
import { NextResponse } from "next/server"
import type { CaptureResult } from "./capture"
import type { DealerRefusal } from "./result"

export const refusalResponse = (refusal: DealerRefusal) => NextResponse.json({ error: refusal.error }, { status: refusal.status })

export const invalidResponse = (what: string, fields: Record<string, string>) =>
  NextResponse.json({ error: `Invalid ${what}`, fields }, { status: 400 })

/** The JSON body, or null when it is absent or not JSON (the parsers then report it). */
export async function readJsonBody(req: Request): Promise<unknown> {
  try {
    return await req.json()
  } catch {
    return null
  }
}

export function captureResponse(what: string, result: CaptureResult): NextResponse {
  if (result.kind === "created") return NextResponse.json({ id: result.id }, { status: 201 })
  if (result.kind === "invalid") return invalidResponse(what, result.fields)
  return refusalResponse(result)
}
