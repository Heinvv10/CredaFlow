import { NextResponse } from "next/server"
import { notFound } from "next/navigation"
import { isNcaJurisdiction } from "./active"
import { ensureActiveJurisdiction } from "./load.server"

/**
 * The refusal an NCA-only API route answers outside the NCA's jurisdiction, or
 * null when it may proceed. 404, not 403: for this lender the resource does not
 * exist. Call it first in each handler, after the role guard. It makes sure the
 * lender's jurisdiction is known first (a handler may run before anything else
 * on the request has loaded it), so a cold process cannot let it through.
 */
export async function ncaOnlyRefusal(what: string): Promise<NextResponse | null> {
  await ensureActiveJurisdiction()
  if (isNcaJurisdiction()) return null
  return NextResponse.json({ error: `${what} does not apply to this lender.` }, { status: 404 })
}

/** The same for a page: notFound() outside the NCA's jurisdiction. */
export async function ncaOnlyPage(): Promise<void> {
  await ensureActiveJurisdiction()
  if (!isNcaJurisdiction()) notFound()
}

/**
 * For a cron route: a 200 "skipped" when the lender is outside the NCA's
 * jurisdiction (so the heartbeat does not read the skip as a failure), else null.
 */
export async function ncaOnlyCronSkip(): Promise<NextResponse | null> {
  await ensureActiveJurisdiction()
  if (isNcaJurisdiction()) return null
  return NextResponse.json({ skipped: "not applicable to this lender" })
}
