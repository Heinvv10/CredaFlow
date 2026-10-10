import { resolveReferralCodeById, recordReferralEvent } from "./referrals"

export function computeCommissionCents(principalCents: number, bps: number): number {
  if (bps <= 0 || principalCents <= 0) return 0
  return Math.round((principalCents * bps) / 10000)
}

export function resolveEffectiveBps(
  agent: { commissionBps: number | null },
  tenantConfig: { referralCommissionBps: number } | null,
): number {
  return agent.commissionBps ?? tenantConfig?.referralCommissionBps ?? 0
}

// Structural client satisfied by PrismaClient and a $transaction tx.
type CommissionClient = {
  client: { findUnique(args: unknown): Promise<unknown> }
  tenantConfig: { findUnique(args: unknown): Promise<unknown> }
  referralCode: unknown
  referralEvent: { findFirst(args: unknown): Promise<unknown>; create(args: unknown): Promise<unknown> }
}

export async function recordDisbursementCommission(
  client: CommissionClient,
  opts: {
    tenantId: string
    loanId: string
    clientId: string
    principalCents: number
    /**
     * Let a REVERSED prior accrual be superseded rather than block this one.
     *
     * DEFAULTED OFF on purpose, and only the manual re-attribution path
     * (lib/referral-agents/retro-attribution.ts) turns it on, for loans whose prior
     * row it reversed itself inside the same transaction. Every other REVERSED
     * row is a clawback written when the loan defaulted
     * (lib/collections/escalation.ts, app/api/cron/dpd-update), and that
     * clawback has to keep blocking re-accrual — which is precisely why this is
     * an explicit opt-in and not implicit behaviour.
     */
    supersedeReversedPriors?: boolean
  },
): Promise<void> {
  const { tenantId, loanId, clientId, principalCents, supersedeReversedPriors } = opts

  const borrower = (await client.client.findUnique({
    where: { id: clientId },
    select: { referralCodeId: true },
  })) as { referralCodeId: string | null } | null
  if (!borrower?.referralCodeId) return // not a referred client

  const referralCode = await resolveReferralCodeById(
    client as unknown as { referralCode: unknown },
    { tenantId, id: borrower.referralCodeId },
  )
  if (!referralCode) return // suspended agent / retired code earns nothing

  const tenantConfig = (await client.tenantConfig.findUnique({
    where: { tenantId },
    select: { referralCommissionBps: true },
  })) as { referralCommissionBps: number } | null

  const bps = resolveEffectiveBps(referralCode.agent, tenantConfig)
  if (bps <= 0) return // commissions off for this agent/tenant

  // Idempotency: never accrue twice for the same loan.
  const prior = await client.referralEvent.findFirst({
    where: {
      tenantId,
      eventType: "CONVERTED",
      metadata: { path: ["loanId"], equals: loanId },
      ...(supersedeReversedPriors ? { commissionStatus: { not: "REVERSED" } } : {}),
    },
    select: { id: true },
  })
  if (prior) return

  const commissionCents = computeCommissionCents(principalCents, bps)
  await recordReferralEvent(client as never, {
    tenantId,
    eventType: "CONVERTED",
    source: "LOAN",
    referralCode,
    amountCents: principalCents,
    commissionCents,
    commissionStatus: "PENDING",
    metadata: { loanId, principalCents, bps },
  })
}

type ReverseClient = {
  referralEvent: { updateMany(args: unknown): Promise<unknown> }
}

export async function reverseReferralCommissionForLoan(
  client: ReverseClient,
  opts: { tenantId: string; loanId: string },
): Promise<void> {
  // Only unpaid accruals are clawed back. (PAID handling arrives with the
  // payout module; nothing sets PAID yet, so there is nothing to guard.)
  await client.referralEvent.updateMany({
    where: {
      tenantId: opts.tenantId,
      eventType: "CONVERTED",
      commissionStatus: { in: ["PENDING", "PAYABLE"] },
      metadata: { path: ["loanId"], equals: opts.loanId },
    },
    data: { commissionStatus: "REVERSED" },
  })
}
