/**
 * Back-fill default interest and post-default charges onto a tenant's existing
 * book.
 *
 * DRY RUN by default — reads only, prints one JSON line per collectible loan
 * and a total, and works while the tenant flag is still OFF so the amounts can
 * be approved before anything is posted:
 *   npx tsx scripts/default-charges-backfill.ts --tenant-id <tenant-id>
 *
 * The dry run also lists every loan failing the ledger identity
 * SUM(schedule.totalPaid) = Loan.totalPaid = SUM(receipts - charge splits),
 * and every issued Section 129 notice with no frozen admin charge.
 *
 * Apply — refuses, writing nothing, once charges were stopped (--disable is
 * one-way) or while any loan fails that identity. Otherwise, in one audited
 * transaction, freezes today's admin charge onto those notices and, unless
 * charges are already live, switches TenantConfig.defaultChargesEnabled on and
 * records go-live; then posts via
 * syncLoanCharges, one transaction and one attributed audit row per changed
 * loan; re-running changes nothing:
 *   npx tsx scripts/default-charges-backfill.ts --tenant-id <tenant-id> \
 *     --actor-email <staff-email> --apply
 *
 * Apply also refuses, writing nothing, while any loan would fail the sweep, or
 * would have money already booked to its instalments moved onto charges,
 * would re-open though settled, or would have its booked split between
 * instalments changed by the s126(3) order (the dry run lists them). Staff resolve each by
 * exempting it (which refunds its charge money) or by accepting it, audited,
 * per loan: --accept <loan-id> (repeatable).
 *
 * Disable — the one-way kill switch, audited: switches the flag off and records
 * when. Nothing is derived again; paid charges stay paid, unpaid ones are not
 * collected, and --apply refuses from then on:
 *   npx tsx scripts/default-charges-backfill.ts --tenant-id <tenant-id> \
 *     --actor-email <staff-email> --disable
 *
 * Exits non-zero if any loan fails to apply.
 */
import { prisma } from "@/lib/prisma"
import { runWithTenant } from "@/lib/tenant-scope"
import { applyChargesBackfill, disableCharges, planChargesBackfill } from "@/lib/loan/charges-backfill"

function option(name: string): string | null {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] ?? null : null
}

/** Every value of a repeatable option. */
function options(name: string): string[] {
  return process.argv.flatMap((arg, i) => (arg === name && process.argv[i + 1] ? [process.argv[i + 1]] : []))
}

async function main(): Promise<void> {
  const tenantId = option("--tenant-id")
  const actorEmail = option("--actor-email")
  const apply = process.argv.includes("--apply")
  const disable = process.argv.includes("--disable")
  if (!tenantId) throw new Error("--tenant-id is required")
  if (apply && disable) throw new Error("--apply and --disable are exclusive")
  if ((apply || disable) && !actorEmail) throw new Error("--actor-email is required with --apply or --disable")
  const asOf = new Date()

  await runWithTenant(tenantId, async () => {
    if (!apply && !disable) {
      const plan = await planChargesBackfill(prisma, tenantId, asOf)
      for (const row of plan.rows) process.stdout.write(`${JSON.stringify(row)}\n`)
      process.stdout.write(`${JSON.stringify({
        mode: "DRY_RUN", money: "cents", asOf: asOf.toISOString(), writes: 0, ...plan.total,
        loansThatWouldFail: plan.wouldFail,
        ledgerMismatches: plan.mismatches,
        noticesToStamp: plan.noticesToStamp,
        loansNeedingAcceptance: plan.needsAcceptance,
      })}\n`)
      return
    }

    const actor = await prisma.user.findFirst({
      where: { tenantId, email: actorEmail!, active: true },
      select: { id: true, email: true },
    })
    if (!actor) throw new Error(`No active user ${actorEmail} in tenant ${tenantId}`)
    if (disable) {
      const result = await disableCharges(prisma, tenantId, asOf, { userId: actor.id, userEmail: actor.email })
      process.stdout.write(`${JSON.stringify({ mode: "DISABLE", ...result })}\n`)
      return
    }
    const result = await applyChargesBackfill(prisma, tenantId, asOf, { userId: actor.id, userEmail: actor.email }, {
      accept: options("--accept"),
    })
    process.stdout.write(`${JSON.stringify({ mode: "APPLY", asOf: asOf.toISOString(), ...result })}\n`)
    if (result.failures.length > 0) process.exitCode = 1
  })
}

main()
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
    process.exit()
  })
