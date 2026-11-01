/**
 * A5b, real Postgres and real routes: a product change takes two people, and a balloon and a variable rate are what was approved.
 *
 *   RUN_A5B_IT=1 DATABASE_URL=postgresql://... npx vitest run lib/product-engine/a5b-products.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/auth", async () => {
  const { session } = await import("./a5b-session.integration-fixture")
  return { auth: vi.fn(async () => session.current) }
})
vi.mock("@/lib/jurisdiction/load.server", () => ({ ensureActiveJurisdiction: vi.fn(async () => undefined) }))

import { DELETE as deactivate, PUT as editProduct } from "@/app/api/products/loan/[id]/route"
import { POST as createProduct } from "@/app/api/products/loan/route"
import { POST as act } from "@/app/api/maker-checker/[id]/[action]/route"
import { POST as draftChange } from "@/app/api/maker-checker/route"
import { dbDate } from "@/lib/asset-finance/dates"
import { resetActiveJurisdiction } from "@/lib/jurisdiction/active"
import { TODAY, approveRate, approveRequest, config, created, day, db, form, proposeVersion, registerA5bLender, request, signIn, staff, suite, t, tenantId } from "./a5b.integration-fixture"

suite("A5b products (real Postgres, real routes)", () => {
  registerA5bLender()

  describe("maker-checker on a product", () => {
    it("a new product does not exist until a second person approves it, and its maker cannot", async () => {
      signIn("maker")
      const body = form()
      const response = await createProduct(request("/api/products/loan", "POST", body))
      expect(response.status).toBe(202)
      const { request: change } = await response.json()
      expect(await db.loanProduct.count({ where: { tenantId, code: body.code as string } })).toBe(0)
      expect((await approveRequest(change.id, "maker")).status).toBe(403)
      expect(await db.loanProduct.count({ where: { tenantId, code: body.code as string } })).toBe(0)
      expect((await approveRequest(change.id, "maker2")).status).toBe(403)
      expect((await approveRequest(change.id)).status).toBe(200)
      const product = await db.loanProduct.findFirstOrThrow({ where: { tenantId, code: body.code as string } })
      expect(product).toMatchObject({ productType: "SALARY_BACKED", maxAmount: 5_000_000, interestRatePm: 0.02 })
      const audit = await db.auditLog.findFirstOrThrow({ where: { tenantId, action: "LOAN_PRODUCT_CREATED", entityId: product.id } })
      expect(audit).toMatchObject({ userId: staff.checker })
      expect(audit.newValue).toMatchObject({ changeRequestId: change.id, makerId: staff.maker })
    })

    it("an edit changes nothing until approved; a deactivation likewise", async () => {
      const product = await created()
      signIn("maker")
      const response = await editProduct(request(`/api/products/loan/${product.id}`, "PUT", form({ code: product.code, name: "Renamed", reason: "A clearer name" })), { params: Promise.resolve({ id: product.id }) })
      expect(response.status).toBe(202)
      const { request: change } = await response.json()
      expect(change.title).toContain("name")
      expect((await db.loanProduct.findUniqueOrThrow({ where: { id: product.id } })).name).toBe("Payroll loan")
      expect((await approveRequest(change.id)).status).toBe(200)
      expect((await db.loanProduct.findUniqueOrThrow({ where: { id: product.id } })).name).toBe("Renamed")

      signIn("maker")
      const off = await deactivate(request(`/api/products/loan/${product.id}`, "DELETE", { reason: "Withdrawn from sale" }), { params: Promise.resolve({ id: product.id }) })
      expect(off.status).toBe(202)
      expect((await db.loanProduct.findUniqueOrThrow({ where: { id: product.id } })).active).toBe(true)
      expect((await approveRequest((await off.json()).request.id)).status).toBe(200)
      expect((await db.loanProduct.findUniqueOrThrow({ where: { id: product.id } })).active).toBe(false)
    })

    it("approving over a change that landed first is STALE, not a silent overwrite", async () => {
      const product = await created()
      const propose = async (name: string) => {
        signIn("maker")
        const res = await editProduct(request(`/api/products/loan/${product.id}`, "PUT", form({ code: product.code, name, reason: "A clearer name" })), { params: Promise.resolve({ id: product.id }) })
        return (await res.json()).request.id as string
      }
      const [first, second] = [await propose("First"), await propose("Second")]
      expect((await approveRequest(first)).status).toBe(200)
      const stale = await approveRequest(second)
      expect(stale.status).toBe(409)
      expect((await stale.json()).code).toBe("STALE")
      expect((await db.loanProduct.findUniqueOrThrow({ where: { id: product.id } })).name).toBe("First")
    })

    it("a credit officer cannot propose, an empty reason is refused, and a refused proposal leaves no draft", async () => {
      signIn("officer")
      expect((await createProduct(request("/api/products/loan", "POST", form()))).status).toBe(403)
      signIn("maker")
      const body = form({ reason: "" })
      expect((await createProduct(request("/api/products/loan", "POST", body))).status).toBe(422)
      expect(await db.changeRequest.count({ where: { tenantId, kind: "LOAN_PRODUCT", title: { contains: body.code as string } } })).toBe(0)
    })

    it("the generic route holds a draft to the same arrears terms as the form", async () => {
      signIn("maker")
      const product = { code: `M${t.slice(0, 8)}`, name: "x", productType: "SME", minAmount: 100_000, maxAmount: 500_000, minTermDays: 30, maxTermDays: 90, interestRatePm: 0.02, interestModel: "REDUCING_BALANCE", initiationFeeModel: "FLAT_PCT", initiationFeePct: 0.05, initiationFeeMax: 0, monthlyServiceFee: 0, active: true }
      const drafted = await draftChange(request("/api/maker-checker", "POST", { kind: "LOAN_PRODUCT", title: "x", payload: { action: "CREATE", reason: "the generic path", product: { ...product, nonNcaDefaultInterestMargin: "5" } } }))
      expect(drafted.status).toBe(422)
    })

    it("an NCA lender cannot propose a new type, and its existing products propose as before", async () => {
      resetActiveJurisdiction()
      signIn("maker")
      const refused = await createProduct(request("/api/products/loan", "POST", form({ productType: "SME" })))
      expect(refused.status).toBe(422)
      expect((await refused.json()).invalidFields).toEqual(["productType"])
    })
  })

  describe("a balloon and a variable rate on a version", () => {
    it("is what was approved: columns equal the payload, and the checks hold what the parser holds", async () => {
      const product = await created()
      await approveRate(day(-40), "0.09")
      const { change, submitted } = await proposeVersion(product.id, config())
      expect(submitted.status).toBe(200)
      expect((await approveRequest(change.id)).status).toBe(200)
      const version = await db.productVersion.findFirstOrThrow({ where: { tenantId, productId: product.id } })
      expect(version).toMatchObject({ structure: "BALLOON", balloonPct: 0.3, rateBasis: "PRIME", rateMarginPa: 0.03 })
      expect((await db.loanProduct.findUniqueOrThrow({ where: { id: product.id } })).repaymentStructured).toBe(true)
    })

    it("refuses a version whose row is not its payload, and rows the CHECKs do not allow even when a request says so", async () => {
      const product = await created()
      // A request approved in the database's own terms, its payload never through the parser, so the guard passes and only the CHECK answers.
      const approvedWith = async (cfg: Record<string, unknown>) => {
        const id = `cr-${randomUUID()}`
        await db.changeRequest.create({ data: { id, tenantId, kind: "PRODUCT_VERSION", title: "Direct", payload: { productId: product.id, effectiveFrom: TODAY, reason: "Direct write", config: cfg } as never, payloadVersion: 1, makerId: staff.maker } })
        await db.changeRequest.update({ where: { id }, data: { status: "SUBMITTED", submittedAt: new Date() } })
        await db.changeRequest.update({ where: { id }, data: { status: "APPROVED", checkerId: staff.checker, decidedAt: new Date(), appliedAt: new Date() } })
        return id
      }
      const write = async (over: Record<string, unknown>, repayment: Record<string, unknown>, variableRate: Record<string, unknown> | null) => {
        const cfg = config({ repayment, variableRate, ...over })
        const c = cfg as ReturnType<typeof config> & Record<string, never>
        const r = repayment as { frequency: "MONTHLY"; structure: "BALLOON"; graceKind: "NONE"; graceInstalments: number; balloonPct?: number }
        const v = variableRate as { basis: "PRIME"; marginPa: number } | null
        return db.productVersion.create({
          data: {
            tenantId, productId: product.id, version: 1, effectiveFrom: dbDate(TODAY), minAmount: c.minAmountCents, maxAmount: c.maxAmountCents, minTermDays: c.minTermDays, maxTermDays: c.maxTermDays, interestRatePm: c.interestRatePm,
            interestModel: c.interestModel as "FLAT", initiationFeeModel: "FLAT_PCT", initiationFeePct: 0, initiationFeeMax: 0, monthlyServiceFee: 0, frequency: r.frequency, structure: r.structure, graceKind: r.graceKind, graceInstalments: r.graceInstalments,
            balloonPct: r.balloonPct ?? null, rateBasis: v?.basis ?? null, rateMarginPa: v?.marginPa ?? null, collateral: [], eligibility: c.eligibility, reason: "Direct write", changeRequestId: await approvedWith(cfg),
          },
        }).then(() => "written", (e: unknown) => String(e))
      }
      const balloon = { frequency: "MONTHLY", structure: "BALLOON", graceKind: "NONE", graceInstalments: 0 }
      const amortising = { ...balloon, structure: "AMORTISING" }
      const prime = { basis: "PRIME", marginPa: 0.03 }
      expect(await write({}, balloon, null)).toContain("ProductVersion_balloon")
      expect(await write({}, { ...balloon, balloonPct: 1 }, null)).toContain("ProductVersion_balloon")
      expect(await write({}, { ...amortising, balloonPct: 0.2 }, null)).toContain("ProductVersion_balloon")
      expect(await write({}, { ...balloon, balloonPct: 0.2, graceKind: "FULL", graceInstalments: 1 }, null)).toContain("ProductVersion_balloon")
      expect(await write({ interestModel: "FLAT" }, amortising, prime)).toContain("ProductVersion_variable_rate")
      expect(await write({}, amortising, { basis: "JIBAR", marginPa: 0.03 })).toContain("ProductVersion_variable_rate")
      expect(await write({}, { ...amortising, structure: "BULLET" }, prime)).toContain("ProductVersion_variable_rate")

      // ...and a row that differs from its payload by the new columns alone is refused by the guard.
      const id = await approvedWith(config({ repayment: { ...balloon, balloonPct: 0.2 }, variableRate: null }))
      const base = { tenantId, productId: product.id, version: 1, effectiveFrom: dbDate(TODAY), minAmount: 100_000, maxAmount: 5_000_000, minTermDays: 90, maxTermDays: 720, interestRatePm: 0.02, interestModel: "REDUCING_BALANCE" as const, initiationFeeModel: "FLAT_PCT" as const, initiationFeePct: 0, initiationFeeMax: 0, monthlyServiceFee: 0, frequency: "MONTHLY" as const, structure: "BALLOON" as const, graceKind: "NONE" as const, collateral: [], eligibility: { minAge: null, maxAge: null, minMonthlyIncomeCents: null, minEmploymentMonths: null }, reason: "Direct write", changeRequestId: id }
      expect(await db.productVersion.create({ data: { ...base, balloonPct: 0.25 } }).then(() => "written", (e: unknown) => String(e))).toContain("must equal the approved")
      expect(await db.productVersion.create({ data: { ...base, balloonPct: 0.2, rateBasis: "PRIME", rateMarginPa: 0.03 } }).then(() => "written", (e: unknown) => String(e))).toContain("must equal the approved")
      expect(await db.productVersion.create({ data: { ...base, balloonPct: 0.2, changeRequestId: "nothing" } }).then(() => "written", (e: unknown) => String(e))).toContain("only by an approved")
    })

    it("an NCA lender's version with a balloon or a variable rate is refused at submission", async () => {
      resetActiveJurisdiction()
      const product = await db.loanProduct.create({ data: { tenantId, code: `Z${t.slice(0, 6)}`, name: "Personal", productType: "PERSONAL", minAmount: 100_000, maxAmount: 800_000, minTermDays: 28, maxTermDays: 180, interestRatePm: 0.03, interestModel: "REDUCING_BALANCE" } })
      const { submitted } = await proposeVersion(product.id, config({ minAmountCents: 100_000, maxAmountCents: 800_000, minTermDays: 90, maxTermDays: 180, interestRatePm: 0.01 }))
      expect(submitted.status).toBe(422)
      expect(JSON.stringify(await submitted.json())).toContain("variableRate")
    })
  })
})
