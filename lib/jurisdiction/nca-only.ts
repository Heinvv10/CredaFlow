import { NextResponse } from "next/server"
import { isNcaJurisdiction } from "./active"

/**
 * The refusal an NCA-only API route answers outside the NCA's jurisdiction, or
 * null when it may proceed. 404, not 403: for this lender the resource does not
 * exist. Call it first in each handler, after the role guard.
 */
export function ncaOnlyRefusal(what: string): NextResponse | null {
  if (isNcaJurisdiction()) return null
  return NextResponse.json({ error: `${what} does not apply to this lender.` }, { status: 404 })
}
