import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { paybillSimulationOffered } from "@/lib/mobile-money/config"
import { canActOnPaymentNotifications } from "@/lib/payments/payment-notifications"
import { ingestMobileMoneyCallback } from "@/lib/mobile-money/c2b-ingest"
import { simulatedC2BPayment, simulatedMpesa, simulatedSecretConfigured } from "@/lib/mobile-money/providers/simulated"
import { MAX_AMOUNT_CENTS } from "@/lib/mobile-money/types"

/** A synthetic payer: the stored last four digits read 0000. */
const SIMULATED_PAYER = "254700000000"

/**
 * "Simulate paybill payment" for the demo: a signed C2B callback for this
 * lender, delivered through the same verification and ingest as the webhook,
 * so it books (or stays UNMATCHED) exactly as a real paybill payment would.
 * It does not exist (404) outside a demo stack (DEMO_MODE=true) that permits
 * simulated-mpesa (lib/mobile-money/config.ts, paybillSimulationOffered).
 */
export async function POST(req: NextRequest) {
  if (!paybillSimulationOffered()) return NextResponse.json({ error: "Not found" }, { status: 404 })
  const guard = await requireApiRole("COLLECTIONS_AGENT")
  if (guard.error) return guard.error
  if (!canActOnPaymentNotifications(guard.user.role)) {
    return NextResponse.json({ error: "Your role cannot record loan payments." }, { status: 403 })
  }
  return withTenantContext(req, async (tenant) => {
    const body = (await req.json().catch(() => null)) as { loanReference?: unknown; amount?: unknown } | null
    const loanReference = typeof body?.loanReference === "string" ? body.loanReference.trim() : ""
    const amount = body?.amount
    if (!loanReference || loanReference.length > 100 || typeof amount !== "number" || !Number.isSafeInteger(amount)
      || amount <= 0 || amount * 100 > MAX_AMOUNT_CENTS) {
      return NextResponse.json({ error: "A loan reference and a positive whole amount are required" }, { status: 400 })
    }
    if (!simulatedSecretConfigured()) {
      return NextResponse.json({ error: "SIMULATED_MPESA_WEBHOOK_SECRET is not set" }, { status: 503 })
    }
    const signed = simulatedC2BPayment({ tenantId: tenant.id, billRef: loanReference, amountCents: amount * 100, msisdn: SIMULATED_PAYER })
    const callback = simulatedMpesa.parseCallback({ ...signed, tenantId: tenant.id })
    if (!callback || callback.kind !== "C2B") return NextResponse.json({ error: "The simulated payment did not verify" }, { status: 503 })
    await logAuditStrict({
      tenantId: tenant.id, userId: guard.user.id, userEmail: guard.user.email ?? undefined,
      action: AuditAction.MOBILE_MONEY_PAYBILL_SIMULATED, entity: "MobileMoneyTransaction",
      newValue: { transId: callback.transId, amount: callback.amountCents, loanReference, simulated: true },
    })
    const { outcome } = await ingestMobileMoneyCallback(prisma, { tenantId: tenant.id, provider: simulatedMpesa, callback })
    return NextResponse.json({ outcome })
  })
}
