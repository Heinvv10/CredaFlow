/**
 * Breaker round 2 on PR #280 (head 03fd5dd1). RUN_A5B_IT=1 DATABASE_URL=... npx vitest run lib/product-engine/brk280-round2.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { beforeAll, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/auth", async () => {
  const { session } = await import("./a5b-session.integration-fixture")
  return { auth: vi.fn(async () => session.current) }
})
vi.mock("@/lib/jurisdiction/load.server", () => ({ ensureActiveJurisdiction: vi.fn(async () => undefined) }))

import { POST as act } from "@/app/api/maker-checker/[id]/[action]/route"
import { POST as draftChange } from "@/app/api/maker-checker/route"
import { PUT as editGroup } from "@/app/api/products/groups/[id]/route"
import { POST as createGroup } from "@/app/api/products/groups/route"
import { dbDate } from "@/lib/asset-finance/dates"
import { sastCalendarDate } from "@/lib/date/sast"
import { prisma } from "@/lib/prisma"
import { setActiveJurisdiction } from "@/lib/jurisdiction/active"
import { groupEditedBy, productTypeRefusal } from "@/lib/product-types/rules"
import { approveRate, approveRequest, bookLoan, config, created, day, db, proposeVersion, registerA5bLender, request, signIn, staff, suite, tenantId } from "./a5b.integration-fixture"
import { planReprice, type StoredRow } from "./reprice"
import { generateSchedule } from "./schedule"
import type { RepaymentTerms } from "./types"

const refusal = async (p: Promise<unknown>) => { try { await p; return null } catch (e) { return String(e) } }

suite("brk280 round 2 (real Postgres)", () => {
  registerA5bLender()
  const client = async () => { const n = randomUUID().replaceAll("-", "").slice(0, 12); return db.client.create({ data: { tenantId, idNumber: `80${n}`, firstName: "Lineo", lastName: `B${n.slice(0, 4)}`, email: `${n}@client.invalid`, phone: "0820000001", employmentStatus: "EMPLOYED" } }) }
  const application = async (productId: string, clientId: string, over: Record<string, unknown> = {}) => { const n = randomUUID().replaceAll("-", "").slice(0, 12); return db.loanApplication.create({ data: { tenantId, reference: `APP-${n}`, clientId, productId, appliedAmount: 200_000, appliedTermDays: 90, status: "SUBMITTED", ...over } }) }
  const loanOn = async (productId: string, clientId: string, status: string, owed: number, daysInArrears = 0) => {
    const app = await application(productId, clientId)
    return db.loan.create({ data: { tenantId, reference: `LN-${randomUUID().slice(0, 8)}`, applicationId: app.id, clientId, productId, principal: owed, totalInterest: 0, initiationFee: 0, totalRepayable: owed, outstandingPrincipal: owed, startDate: new Date(), maturityDate: new Date(), interestRatePm: 0, interestModel: "REDUCING_BALANCE", status: status as never, daysInArrears } })
  }
  const gate = (clientId: string, productId: string, productType: string, principalCents: number, limitCents: number, id = "draw") => productTypeRefusal(prisma, tenantId, { id, clientId, productId, loanPurposeCategory: null, product: { productType } }, { principalCents, limitCents })

  describe("round 1 (a) revolving limit", () => {
    for (const status of ["DEFAULTED", "PENDING_WRITE_OFF", "WRITTEN_OFF", "RESTRUCTURED"]) {
      it(`counts principal still owed on a ${status} loan`, async () => {
        const product = await created({ productType: "REVOLVING" })
        const b = await client()
        await loanOn(product.id, b.id, status, 450_000)
        expect(await gate(b.id, product.id, "REVOLVING", 200_000, 500_000)).toContain("exceeds the revolving limit")
      })
    }
    it("counts an approved draw not yet disbursed", async () => {
      const product = await created({ productType: "REVOLVING" })
      const b = await client()
      const pending = await application(product.id, b.id, { appliedAmount: 450_000 })
      // Setup only, rolled back: the APPROVED status without the whole PASQ the CHECKs want; the gate reads it in the same transaction.
      let seen: string | null = "not run"
      await db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`)
        await tx.$executeRawUnsafe(`DO $$ DECLARE c TEXT; BEGIN FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = '"LoanApplication"'::regclass AND contype = 'c' LOOP EXECUTE format('ALTER TABLE "LoanApplication" DROP CONSTRAINT %I', c); END LOOP; END $$`)
        await tx.$executeRaw`UPDATE "LoanApplication" SET "status" = 'APPROVED', "approvedAmount" = 450000 WHERE "id" = ${pending.id}`
        seen = await productTypeRefusal(tx as never, tenantId, { id: "draw", clientId: b.id, productId: product.id, loanPurposeCategory: null, product: { productType: "REVOLVING" } }, { principalCents: 200_000, limitCents: 500_000 })
        throw new Error("rollback")
      }).catch((e) => { if (String(e).indexOf("rollback") < 0) throw e })
      expect(seen).toContain("exceeds the revolving limit")
    })
  })

  describe("round 1 (b) group arrears", () => {
    for (const status of ["DEFAULTED", "PENDING_WRITE_OFF", "WRITTEN_OFF"]) {
      it(`a member's ${status} loan stops the group`, async () => {
        const product = await created({ productType: "GROUP" })
        const [a, b] = [await client(), await client()]
        signIn("officer")
        const { group } = await (await createGroup(request("/api/products/groups", "POST", { name: `G ${randomUUID().slice(0, 8)}`, memberIdNumbers: [a.idNumber, b.idNumber] }))).json()
        const app = await application(product.id, a.id)
        await db.applicationProductFacts.create({ data: { applicationId: app.id, tenantId, borrowerGroupId: group.id, updatedById: staff.officer } })
        await loanOn(product.id, b.id, status, 300_000, 0)
        expect(await gate(a.id, product.id, "GROUP", 100_000, 5_000_000, app.id)).toContain("in arrears")
      })
    }
  })

  describe("round 1 (c) segregation of duties on a group edit", () => {
    it("the editor is input staff of the open application and is barred from approving it", async () => {
      const product = await created({ productType: "GROUP" })
      const [a, b, c] = [await client(), await client(), await client()]
      signIn("maker")
      const { group } = await (await createGroup(request("/api/products/groups", "POST", { name: `G ${randomUUID().slice(0, 8)}`, memberIdNumbers: [b.idNumber, c.idNumber] }))).json()
      const app = await application(product.id, a.id, { status: "UNDER_REVIEW" })
      await db.applicationProductFacts.create({ data: { applicationId: app.id, tenantId, borrowerGroupId: group.id, updatedById: staff.maker } })
      signIn("officer")
      expect((await editGroup(request(`/api/products/groups/${group.id}`, "PUT", { memberIdNumbers: [a.idNumber, b.idNumber, c.idNumber] }), { params: Promise.resolve({ id: group.id }) })).status).toBe(200)
      expect((await db.loanApplication.findFirstOrThrow({ where: { id: app.id } })).inputStaffIds).toContain(staff.officer)
      expect(await groupEditedBy(prisma, tenantId, app.id, staff.officer)).toBe(true)
      expect(await groupEditedBy(prisma, tenantId, app.id, staff.maker)).toBe(true)
    })
  })

  it("round 1 LOW: the generic maker-checker route refuses a 500% default margin", async () => {
    signIn("maker")
    const product = { code: `M${randomUUID().slice(0, 8).toUpperCase()}`, name: "x", productType: "SME", minAmount: 100_000, maxAmount: 500_000, minTermDays: 30, maxTermDays: 90, interestRatePm: 0.02, interestModel: "REDUCING_BALANCE", initiationFeeModel: "FLAT_PCT", initiationFeePct: 0.5, initiationFeeMax: 0, monthlyServiceFee: 0, active: true, nonNcaDefaultInterestMargin: "5" }
    expect((await draftChange(request("/api/maker-checker", "POST", { kind: "LOAN_PRODUCT", title: "x", payload: { action: "CREATE", reason: "the generic path", product } }))).status).not.toBe(201)
  })

  describe("guardLoanTerms", () => {
    let productId: string
    let versionId: string
    const terms: RepaymentTerms = { frequency: "MONTHLY", structure: "BALLOON", graceKind: "NONE", graceInstalments: 0, instalments: 12, balloonPct: 0.3 }
    beforeAll(async () => {
      setActiveJurisdiction({ jurisdiction: "LS", currency: "LSL" })
      const product = await created({ productType: "PERSONAL" })
      productId = product.id
      const { change } = await proposeVersion(productId, config({ variableRate: { basis: "LENDER_BASE", marginPa: 0.03 } }))
      await approveRequest(change.id)
      versionId = (await db.productVersion.findFirstOrThrow({ where: { tenantId, productId } })).id
      await approveRate(day(-10), "0.08", "LENDER_BASE")
      await approveRate(day(5), "0.07", "LENDER_BASE")
    })
    const book = () => bookLoan(productId, versionId, { terms, ratePm: 0.01, start: new Date(Date.now() - 95 * 86_400_000), reference: { rate: 0.09, date: day(-200), marginPa: 0.03 } })
    const repricing = (loanId: string, over: Record<string, unknown> = {}) => db.loanTerms.create({ data: {
      tenantId, loanId, sequence: 2, productVersionId: versionId, frequency: "MONTHLY", structure: "BALLOON", graceKind: "NONE", graceInstalments: 0, instalments: 12, balloonCents: 300_000,
      baseRatePm: (0.08 + 0.03) / 12, interestRatePm: (0.08 + 0.03) / 12, rateBasis: "LENDER_BASE", rateMarginPa: 0.03, referenceRate: 0.08, referenceEffectiveDate: dbDate(day(-10)), ...over } })

    it("refuses a repricing row whose rate is not reference + margin", async () => {
      const { loanId } = await book()
      expect(await refusal(repricing(loanId, { baseRatePm: 0.001, interestRatePm: 0.001 }))).toContain("approved reference rate")
    })
    it("refuses a repricing row that moves the structure or the balloon", async () => {
      const { loanId } = await book()
      expect(await refusal(repricing(loanId, { balloonCents: 0 }))).toContain("approved reference rate")
      expect(await refusal(repricing(loanId, { instalments: 24 }))).toContain("approved reference rate")
    })
    it("FINDING if it passes: a repricing row on an approved reference value dated in the future", async () => {
      const { loanId } = await book()
      const r = await refusal(repricing(loanId, { baseRatePm: (0.07 + 0.03) / 12, interestRatePm: (0.07 + 0.03) / 12, referenceRate: 0.07, referenceEffectiveDate: dbDate(day(5)) }))
      expect(r).toBeNull() // passes = the DB accepts it (finding)
    })
    it("refuses loan A's approved change request on loan B's terms", async () => {
      const a = await book()
      const b = await book()
      const id = `cr_${randomUUID().slice(0, 12)}`
      await db.$transaction([db.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`),
        db.$executeRaw`INSERT INTO "ChangeRequest" ("id","tenantId","kind","title","payload","payloadVersion","makerId","checkerId","status","submittedAt","decidedAt","appliedAt","createdAt","updatedAt") VALUES (${id}, ${tenantId}, 'LOAN_CHANGE', 'x', ${JSON.stringify({ loanId: a.loanId, type: "TERM_CHANGE" })}::jsonb, 1, ${staff.maker}, ${staff.checker}, 'APPROVED', now(), now(), now(), now(), now())`])
      expect(await refusal(db.loanTerms.create({ data: { tenantId, loanId: b.loanId, sequence: 2, changeRequestId: id, baseRatePm: 0.01, interestRatePm: 0.01 } }))).toContain("approved LOAN_CHANGE")
      expect(await refusal(db.loanTerms.create({ data: { tenantId, loanId: a.loanId, sequence: 2, changeRequestId: id, baseRatePm: 0.01, interestRatePm: 0.01 } }))).toBeNull()
    })
  })

  it("planReprice with carried principal and interest: conserves principal and carried interest, no negatives (fuzz)", () => {
    let seed = 2802
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n }
    const problems: string[] = []
    for (let i = 0; i < 6000; i++) {
      const structure = (["AMORTISING", "INTEREST_ONLY", "BALLOON"] as const)[rnd(3)]!
      const instalments = 2 + rnd(48)
      const P = 10_000 + rnd(20_000_000)
      const balloonPct = structure === "BALLOON" ? (1 + rnd(98)) / 100 : undefined
      const start = new Date(Date.UTC(2026, 0, 15))
      const s = generateSchedule({ principalCents: P, interestRatePm: 0.005 + rnd(50) / 1000, interestModel: "REDUCING_BALANCE", monthlyServiceFeeCents: 0, startDate: start, terms: { frequency: "MONTHLY", structure, graceKind: "NONE", graceInstalments: 0, instalments, ...(balloonPct ? { balloonPct } : {}) } })
      const rows: StoredRow[] = s.schedule.map((r, k) => {
        const cp = rnd(4) === 0 ? Math.min(r.principalDue, rnd(50_000)) : 0
        const ci = rnd(4) === 0 ? Math.min(r.interestDue, rnd(20_000)) : 0
        return { id: `r${k}`, installmentNo: k + 1, dueDate: r.dueDate, principalDue: r.principalDue, interestDue: r.interestDue, feesDue: r.feesDue, creditLifePremiumDue: 0, totalDue: r.totalDue, totalPaid: 0, status: "PENDING", carriedPrincipalDue: cp, carriedInterestDue: ci }
      })
      const plan = planReprice({ rows, startDate: start, frequency: "MONTHLY", structure, balloonCents: balloonPct ? Math.round(P * balloonPct) : 0, newRatePm: rnd(8) === 0 ? 0 : rnd(80) / 1000, effectiveDate: sastCalendarDate(start), today: sastCalendarDate(start) })
      if (!plan) continue
      const tail = rows.filter((r) => plan.updates.some((u) => u.id === r.id))
      if (tail.reduce((a, r) => a + r.principalDue, 0) !== plan.updates.reduce((a, u) => a + u.principalDue, 0)) problems.push(`principal ${i}`)
      for (const [k, u] of plan.updates.entries()) {
        if (u.principalDue < tail[k]!.carriedPrincipalDue! || u.interestDue < tail[k]!.carriedInterestDue! || u.principalDue < 0) problems.push(`carried ${i}`)
        if (u.totalDue !== u.principalDue + u.interestDue + tail[k]!.feesDue) problems.push(`total ${i}`)
      }
    }
    expect(problems.slice(0, 10)).toEqual([])
  })
})
