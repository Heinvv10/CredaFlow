/**
 * Shared by the accounting, Xero and payout routes: the TOTP gate on writes
 * (the same rule as app/api/settings/bureau) and a safe JSON body read.
 */
import { Prisma } from "@prisma/client"
import { NextResponse } from "next/server"
import { isStaffTotpRequired } from "@/lib/security/staff-totp-policy"

/** 403 when this lender requires staff 2FA and this session did not verify a code. */
export async function totpWriteRefusal(tenantId: string, user: { totpVerified?: boolean }, what: string): Promise<NextResponse | null> {
  if ((await isStaffTotpRequired(tenantId)) && user.totpVerified !== true) {
    return NextResponse.json(
      { error: `Sign in with two-factor authentication to ${what}. Enable it under Settings → Security, then sign out and back in.` },
      { status: 403 },
    )
  }
  return null
}

export async function readJson(req: Request): Promise<{ ok: true; body: unknown } | { ok: false; response: NextResponse }> {
  try {
    return { ok: true, body: await req.json() }
  } catch {
    return { ok: false, response: NextResponse.json({ error: "Invalid JSON body." }, { status: 400 }) }
  }
}

/**
 * Takes the lock closePeriod holds (lib/accounting/generate.ts) until the transaction ends, so a settings or mapping
 * write cannot interleave with a month closing or with another such write: what it checked is still true when it writes.
 */
export async function lockAccounting(tx: Pick<Prisma.TransactionClient, "$executeRaw">, tenantId: string): Promise<void> {
  await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${`accounting-export:${tenantId}`}))`)
}
