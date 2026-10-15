/**
 * An s127 recovery follows a surrender that is still open: REQUESTED, VALUED
 * or VALUATION_NOTICE_ISSUED. One whose surrender has been credited or has had
 * its final notice is refused (the rule the migration gained after the first
 * review round, found uncovered by recovery-migration-coverage.test.ts).
 *
 *   RUN_ASSET_FINANCE_RECOVERY_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/asset-finance/recovery-rules-s127.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, it, vi } from "vitest"
import { dbDate } from "./dates"
import { testSetup } from "./lease-servicing.integration-fixture"
import { cleanupRecoveryFixture, createRecoveryFixture, newLoan, newSurrender, recoveryFixtureTenantId, today, type RecoveryFixture, type RecoveryLoan } from "./recovery.integration-fixture"
import { raiseOff, rules, type Tx } from "./recovery-rules.integration-fixture"

// The deal fixture imports the real route handlers, which import the session helper.
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }))

const RUN = process.env.RUN_ASSET_FINANCE_RECOVERY_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
const database = (): PrismaClient => {
  if (!db) throw new Error("RUN_ASSET_FINANCE_RECOVERY_IT=1 is required")
  return db
}
const { refuses, admits } = rules(database)
let fx: RecoveryFixture
const loans = {} as Record<"open" | "noticed" | "credited", RecoveryLoan>
const surrenders = {} as Record<"open" | "noticed" | "credited", string>

const open = (name: "open" | "noticed" | "credited") => (tx: Tx) => tx.recovery.create({
  data: {
    tenantId: fx.tenantId, loanId: loans[name].loanId, assetId: loans[name].assetId, route: "NCA_S127_SURRENDER", surrenderRequestId: surrenders[name], recoveredOn: dbDate(today()),
    location: "TEST Yard", condition: "Synthetic: fair", createdById: fx.officer,
  },
})

suite("an s127 recovery follows an open surrender", () => {
  beforeAll(async () => {
    fx = await createRecoveryFixture(database(), t)
    for (const name of ["open", "noticed", "credited"] as const) {
      loans[name] = await newLoan(database(), fx, "NCA")
      surrenders[name] = await newSurrender(database(), fx, loans[name])
    }
    await testSetup(database(),
      [`UPDATE "SurrenderRequest" SET "status" = 'FINAL_NOTICE_ISSUED', "finalNoticePath" = '/nonexistent/fn.pdf', "finalNoticeSha256" = $2 WHERE "id" = $1`, surrenders.noticed, "a".repeat(64)],
      [`UPDATE "SurrenderRequest" SET "status" = 'PROCEEDS_CREDITED' WHERE "id" = $1`, surrenders.credited],
    )
  }, 180_000)

  afterAll(async () => {
    await cleanupRecoveryFixture(database(), recoveryFixtureTenantId(t)).catch(() => undefined)
    await database().$disconnect()
  }, 60_000)

  it("refuses a surrender that has had its final notice or been credited, admits an open one", async () => {
    const rule = raiseOff("guardRecovery", "An s127 recovery follows a surrender that has not yet been credited or finally noticed")
    await refuses(rule, /follows a surrender that has not yet been credited or finally noticed/, open("noticed"))
    await refuses(rule, /follows a surrender that has not yet been credited or finally noticed/, open("credited"))
    await admits(open("open"))
  })
})
