/**
 * A5b, real Postgres and real routes: the salary-backed, SME, group and revolving types: their facts, groups, deduction list and gates.
 *
 *   RUN_A5B_IT=1 DATABASE_URL=postgresql://... npx vitest run lib/product-engine/a5b-types.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/auth", async () => {
  const { session } = await import("./a5b-session.integration-fixture")
  return { auth: vi.fn(async () => session.current) }
})
vi.mock("@/lib/jurisdiction/load.server", () => ({ ensureActiveJurisdiction: vi.fn(async () => undefined) }))

import { PUT as setFacts } from "@/app/api/applications/[id]/product-facts/route"
import { GET as deductions } from "@/app/api/products/check-off/deductions/route"
import { PUT as editGroup } from "@/app/api/products/groups/[id]/route"
import { POST as createGroup } from "@/app/api/products/groups/route"
import { prisma } from "@/lib/prisma"
import { groupEditedBy, productTypeRefusal } from "@/lib/product-types/rules"
import { created, day, db, registerA5bLender, request, signIn, staff, suite, t, tenantId } from "./a5b.integration-fixture"

suite("A5b product types (real Postgres, real routes)", () => {
  registerA5bLender()

  describe("the product types", () => {
    const client = async (over: Record<string, unknown> = {}) => {
      const n = randomUUID().replaceAll("-", "").slice(0, 12)
      return db.client.create({ data: { tenantId, idNumber: `80${n}`, firstName: "Lineo", lastName: `Member${n.slice(0, 4)}`, email: `${n}@client.invalid`, phone: "0820000001", employmentStatus: "EMPLOYED", ...over } })
    }
    const application = async (productId: string, clientId: string, over: Record<string, unknown> = {}) => {
      const n = randomUUID().replaceAll("-", "").slice(0, 12)
      return db.loanApplication.create({ data: { tenantId, reference: `APP-${n}`, clientId, productId, appliedAmount: 200_000, appliedTermDays: 90, status: "SUBMITTED", ...over } })
    }
    const gate = (app: { id: string; clientId: string | null; productId: string; loanPurposeCategory: string | null }, productType: string, principalCents = 200_000, limitCents = 5_000_000) =>
      productTypeRefusal(prisma, tenantId, { ...app, product: { productType } }, { principalCents, limitCents })
    const facts = (id: string, body: unknown) => { signIn("officer"); return setFacts(request(`/api/applications/${id}/product-facts`, "PUT", body), { params: Promise.resolve({ id }) }) }

    it("salary-backed: refused until the facts are set; whoever sets them is on the input staff; closed applications are refused; the deduction list follows", async () => {
      const product = await created()
      const borrower = await client()
      const app = await application(product.id, borrower.id)
      expect(await gate(app, "SALARY_BACKED")).toContain("employer")
      expect((await facts(app.id, { employerName: "Maluti Mining", payrollNumber: "P-7" })).status).toBe(200)
      expect(await gate(app, "SALARY_BACKED")).toBeNull()
      expect((await db.loanApplication.findUniqueOrThrow({ where: { id: app.id } })).inputStaffIds).toContain(staff.officer)
      expect(await db.auditLog.count({ where: { tenantId, entityId: app.id, action: "APPLICATION_PRODUCT_FACTS_SET", userId: staff.officer } })).toBe(1)

      const closed = await application(product.id, (await client()).id, { status: "DECLINED" })
      expect((await facts(closed.id, { employerName: "Other", payrollNumber: "P-8" })).status).toBe(409)

      const due = new Date(`${day(10)}T08:00:00+02:00`)
      const n = randomUUID().slice(0, 8)
      const loan = await db.loan.create({ data: { tenantId, reference: `LN-${n}`, applicationId: app.id, clientId: borrower.id, productId: product.id, principal: 200_000, totalInterest: 0, initiationFee: 0, totalRepayable: 200_000, outstandingPrincipal: 200_000, startDate: new Date(), maturityDate: due, interestRatePm: 0, interestModel: "REDUCING_BALANCE", status: "ACTIVE" } })
      await db.repaymentSchedule.create({ data: { tenantId, loanId: loan.id, installmentNo: 1, dueDate: due, principalDue: 200_000, interestDue: 0, feesDue: 0, totalDue: 200_000, totalPaid: 50_000, status: "PARTIAL" } })
      signIn("officer")
      const month = day(10).slice(0, 7)
      const listed = await (await deductions(request(`/api/products/check-off/deductions?month=${month}`))).json()
      expect(listed.rows).toEqual([expect.objectContaining({ employer: "Maluti Mining", payrollNumber: "P-7", loanReference: `LN-${n}`, amountCents: 150_000 })])
      const csv = await deductions(request(`/api/products/check-off/deductions?month=${month}&format=csv`))
      expect(await csv.text()).toContain('"Maluti Mining","P-7"')
      expect(await db.auditLog.count({ where: { tenantId, action: "CHECK_OFF_DEDUCTIONS_EXPORTED", userId: staff.officer } })).toBe(1)
    })

    it("SME: the business's facts and a business purpose", async () => {
      const product = await created({ productType: "SME" })
      const app = await application(product.id, (await client()).id, { loanPurposeCategory: "BUSINESS" })
      expect(await gate(app, "SME")).toContain("business's name")
      expect((await facts(app.id, { businessName: "Maluti Traders", businessRegistrationNumber: "2020/1", annualTurnoverCents: 900_000_000 })).status).toBe(200)
      expect(await gate(app, "SME")).toBeNull()
      expect(await gate({ ...app, loanPurposeCategory: "MEDICAL" }, "SME")).toContain("business purpose")
      expect((await facts(app.id, { businessName: "x" })).status).toBe(422)
    })

    it("group: a real group of the lender's clients, refused while a member is in arrears", async () => {
      const product = await created({ productType: "GROUP" })
      const [a, b] = [await client(), await client()]
      signIn("officer")
      expect((await createGroup(request("/api/products/groups", "POST", { name: "One member", memberIdNumbers: [a.idNumber] }))).status).toBe(422)
      expect((await createGroup(request("/api/products/groups", "POST", { name: "Ghost", memberIdNumbers: [a.idNumber, "000"] }))).status).toBe(422)
      const made = await createGroup(request("/api/products/groups", "POST", { name: `Group ${t}`, memberIdNumbers: [a.idNumber, b.idNumber] }))
      expect(made.status).toBe(201)
      const { group } = await made.json()
      const app = await application(product.id, a.id)
      expect(await gate(app, "GROUP")).toContain("lending group")
      expect((await facts(app.id, { borrowerGroupId: "not-a-group" })).status).toBe(422)
      expect((await facts(app.id, { borrowerGroupId: group.id })).status).toBe(200)
      expect(await gate(app, "GROUP")).toBeNull()

      const other = await application(product.id, b.id)
      const n = randomUUID().slice(0, 8)
      await db.loan.create({ data: { tenantId, reference: `LN-${n}`, applicationId: other.id, clientId: b.id, productId: product.id, principal: 100_000, totalInterest: 0, initiationFee: 0, totalRepayable: 100_000, outstandingPrincipal: 100_000, startDate: new Date(), maturityDate: new Date(), interestRatePm: 0, interestModel: "REDUCING_BALANCE", status: "ACTIVE", daysInArrears: 3 } })
      expect(await gate(app, "GROUP")).toContain("in arrears")
    })

    it("revolving: what is still owed counts against the limit, and a repaid draw frees it", async () => {
      const product = await created({ productType: "REVOLVING" })
      const borrower = await client()
      const first = await application(product.id, borrower.id)
      const n = randomUUID().slice(0, 8)
      const loan = await db.loan.create({ data: { tenantId, reference: `LN-${n}`, applicationId: first.id, clientId: borrower.id, productId: product.id, principal: 400_000, totalInterest: 0, initiationFee: 0, totalRepayable: 400_000, outstandingPrincipal: 400_000, startDate: new Date(), maturityDate: new Date(), interestRatePm: 0, interestModel: "REDUCING_BALANCE", status: "ACTIVE" } })
      const second = { id: "draw", clientId: borrower.id, productId: product.id, loanPurposeCategory: null }
      expect(await gate(second, "REVOLVING", 200_000, 500_000)).toContain("exceeds the revolving limit")
      expect(await gate(second, "REVOLVING", 100_000, 500_000)).toBeNull()
      await db.loan.update({ where: { id: loan.id }, data: { outstandingPrincipal: 300_000 } })
      expect(await gate(second, "REVOLVING", 200_000, 500_000)).toBeNull()
      // A default does not free the limit: the balance is still owed.
      await db.loan.update({ where: { id: loan.id }, data: { status: "DEFAULTED" } })
      expect(await gate(second, "REVOLVING", 300_000, 500_000)).toContain("exceeds the revolving limit")
      await db.loan.update({ where: { id: loan.id }, data: { status: "WRITTEN_OFF", writeOffAt: new Date() } })
      expect(await gate(second, "REVOLVING", 300_000, 500_000)).toContain("exceeds the revolving limit")
    })

    it("revolving: the limit runs across the client's revolving products, and counts a draw approved on another", async () => {
      const [one, two] = [await created({ productType: "REVOLVING" }), await created({ productType: "REVOLVING" })]
      const borrower = await client()
      const first = await application(one.id, borrower.id)
      const n = randomUUID().slice(0, 8)
      await db.loan.create({ data: { tenantId, reference: `LN-${n}`, applicationId: first.id, clientId: borrower.id, productId: one.id, principal: 300_000, totalInterest: 0, initiationFee: 0, totalRepayable: 300_000, outstandingPrincipal: 300_000, startDate: new Date(), maturityDate: new Date(), interestRatePm: 0, interestModel: "REDUCING_BALANCE", status: "ACTIVE" } })
      const draw = { id: "draw", clientId: borrower.id, productId: two.id, loanPurposeCategory: null }
      expect(await gate(draw, "REVOLVING", 300_000, 500_000)).toContain("exceeds the revolving limit")
      expect(await gate(draw, "REVOLVING", 200_000, 500_000)).toBeNull()
    })

    it("a group of another lender is not this lender's to edit", async () => {
      const other = `t_a5b_x_${t}`
      await db.tenant.create({ data: { id: other, slug: `a5b-x-${t}`, name: "Other" } })
      const foreign = await db.borrowerGroup.create({ data: { tenantId: other, name: "Foreign", createdById: "x" } })
      const [a, b] = [await client(), await client()]
      signIn("officer")
      expect((await editGroup(request(`/api/products/groups/${foreign.id}`, "PUT", { memberIdNumbers: [a.idNumber, b.idNumber] }), { params: Promise.resolve({ id: foreign.id }) })).status).toBe(404)
    })

    it("a member one day in arrears stops the group", async () => {
      const product = await created({ productType: "GROUP" })
      const [a, b] = [await client(), await client()]
      signIn("officer")
      const { group } = await (await createGroup(request("/api/products/groups", "POST", { name: `One day ${t}`, memberIdNumbers: [a.idNumber, b.idNumber] }))).json()
      const app = await application(product.id, a.id)
      await facts(app.id, { borrowerGroupId: group.id })
      const other = await application(product.id, b.id)
      const n = randomUUID().slice(0, 8)
      await db.loan.create({ data: { tenantId, reference: `LN-${n}`, applicationId: other.id, clientId: b.id, productId: product.id, principal: 100_000, totalInterest: 0, initiationFee: 0, totalRepayable: 100_000, outstandingPrincipal: 100_000, startDate: new Date(), maturityDate: new Date(), interestRatePm: 0, interestModel: "REDUCING_BALANCE", status: "ACTIVE", daysInArrears: 1 } })
      expect(await gate(app, "GROUP")).toContain("in arrears")
    })

    it("a group member's default or write-off stops the group, and whoever edits the group joins its open applications' input staff", async () => {
      const product = await created({ productType: "GROUP" })
      const [a, b, c] = [await client(), await client(), await client()]
      signIn("officer")
      const { group } = await (await createGroup(request("/api/products/groups", "POST", { name: `Edit ${t}`, memberIdNumbers: [a.idNumber, b.idNumber] }))).json()
      const app = await application(product.id, a.id)
      expect((await facts(app.id, { borrowerGroupId: group.id })).status).toBe(200)

      const other = await application(product.id, b.id)
      const n = randomUUID().slice(0, 8)
      const loan = await db.loan.create({ data: { tenantId, reference: `LN-${n}`, applicationId: other.id, clientId: b.id, productId: product.id, principal: 100_000, totalInterest: 0, initiationFee: 0, totalRepayable: 100_000, outstandingPrincipal: 100_000, startDate: new Date(), maturityDate: new Date(), interestRatePm: 0, interestModel: "REDUCING_BALANCE", status: "DEFAULTED" } })
      expect(await gate(app, "GROUP")).toContain("in arrears")
      await db.loan.update({ where: { id: loan.id }, data: { status: "PENDING_WRITE_OFF" } })
      expect(await gate(app, "GROUP")).toContain("in arrears")
      await db.loan.update({ where: { id: loan.id }, data: { status: "WRITTEN_OFF", writeOffAt: new Date() } })
      expect(await gate(app, "GROUP")).toContain("in arrears")
      await db.loan.update({ where: { id: loan.id }, data: { status: "COMPLETED" } })
      expect(await gate(app, "GROUP")).toBeNull()

      signIn("checker")
      const replaced = await editGroup(request(`/api/products/groups/${group.id}`, "PUT", { memberIdNumbers: [a.idNumber, c.idNumber] }), { params: Promise.resolve({ id: group.id }) })
      expect(replaced.status).toBe(200)
      const after = await db.loanApplication.findUniqueOrThrow({ where: { id: app.id } })
      expect(after.inputStaffIds).toContain(staff.checker)
      expect(await groupEditedBy(prisma, tenantId, app.id, staff.checker)).toBe(true)
      expect(await groupEditedBy(prisma, tenantId, app.id, staff.maker)).toBe(false)
      // A closed application on the group is decided: an edit does not make the editor its input staff.
      const declined = await application(product.id, c.id, { status: "DECLINED" })
      await db.applicationProductFacts.create({ data: { applicationId: declined.id, tenantId, borrowerGroupId: group.id, updatedById: staff.officer } })
      signIn("maker2")
      expect((await editGroup(request(`/api/products/groups/${group.id}`, "PUT", { memberIdNumbers: [a.idNumber, b.idNumber] }), { params: Promise.resolve({ id: group.id }) })).status).toBe(200)
      expect((await db.loanApplication.findUniqueOrThrow({ where: { id: declined.id } })).inputStaffIds).not.toContain(staff.maker2)
      expect((await db.loanApplication.findUniqueOrThrow({ where: { id: app.id } })).inputStaffIds).toContain(staff.maker2)
    })
  })
})
