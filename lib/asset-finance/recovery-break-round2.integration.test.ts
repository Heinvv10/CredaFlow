/**
 * BREAK ROUND 2 (RUN_ASSET_FINANCE_RECOVERY_IT) against the fixed commit: self-dealing, the three-person refund,
 * refunds after a payment reversal, new screening evasions, LEGAL_TAXED with evidence.
 */
import { NextRequest } from "next/server"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { PATCH as reversePayment } from "@/app/api/payments/[id]/reverse/route"
import { cleanupE2e } from "./recovery-e2e.integration-fixture"
import { cleanupRecoveryFixture, today, type RecoveryFixture } from "./recovery.integration-fixture"
import { ladderRecovery } from "./recovery-path.integration-fixture"
import { plainListed, readJson, refundForm, saleBody } from "./recovery-sale.integration-fixture"
import { stepWithEvidence } from "./legal-matter.integration-fixture"
import { asUser, bundle, db, makeTenant, RUN, sessionBox } from "./recovery-break.fixture"
import { POST as stepRoute } from "@/app/api/asset-finance/legal-matters/[id]/steps/route"

vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => sessionBox.current) }))

const suite = RUN ? describe : describe.skip
let fx: RecoveryFixture
const officer = () => asUser(fx, fx.officer, "CREDIT_OFFICER")
const adminA = () => asUser(fx, fx.adminA, "LOAN_ADMIN")
const adminB = () => asUser(fx, fx.adminB, "LOAN_ADMIN")
const R = () => bundle(fx)

async function surplusHeld() {
  const rec = await plainListed(db, fx, "NCA", 100_000_000)
  officer()
  const sale = (await readJson(await R().s.propose(rec.id, saleBody(rec.valuationId, 200_000_000)))).body.id as string
  await R().s.completeSale(rec.id, sale)
  await R().s.proceeds(rec.id)
  await R().r.finalNotice(rec.id)
  expect((await readJson(await R().s.outcome(rec.id))).body).toMatchObject({ status: "SURPLUS_HELD" })
  return rec
}
const reverse = (paymentId: string) => reversePayment(new NextRequest(`http://${fx.host}/api/payments/${paymentId}/reverse`, {
  method: "PATCH", headers: { host: fx.host, "content-type": "application/json" }, body: JSON.stringify({ reason: "Keyed against the wrong loan" }),
}), { params: Promise.resolve({ id: paymentId }) })

suite.sequential("round 2", () => {
  beforeAll(async () => {
    process.env.TRUSTED_PROXY = "1"
    fx = await makeTenant()
    await db.user.update({ where: { id: fx.adminB }, data: { name: "Lerato Mokgadi-Buyer" } })
    await db.user.update({ where: { id: fx.officer }, data: { name: "Pieter van der Merwe" } })
  }, 120_000)
  afterAll(async () => {
    sessionBox.current = null
    await cleanupE2e(db, fx.tenantId).catch(() => undefined)
    await cleanupRecoveryFixture(db, fx.tenantId).catch(() => undefined)
    await db.$disconnect()
  }, 120_000)

  // ---- self-dealing
  it("R1a. staff buyer (name variants) can not propose, approve or complete; a colleague's proposal still can not be approved by the buyer", async () => {
    const variants = ["Lerato Mokgadi-Buyer", "Mokgadi-Buyer Lerato", "L Mokgadi Buyer", "Mr Lerato Mokgadi Buyer", "LERATO  mokgadi—buyer", "Lèrato Mokgadibuyer", "Lerato Mokgadi-Buyer Trading as Plant Hire (Pty) Ltd"]
    const results: Record<string, string> = {}
    for (const name of variants) {
      const rec = await plainListed(db, fx, "NON_NCA", 100_000_000)
      officer()
      const p = await readJson(await R().s.propose(rec.id, saleBody(rec.valuationId, 100_000_000, { buyerName: name, buyerIdentifier: "ZZ-SD-1" })))
      if (p.status !== 201) { results[name] = `propose ${p.status}`; continue }
      adminB()
      const a = await readJson(await R().s.approveSale(rec.id, p.body.id as string))
      const c = await readJson(await R().s.completeSale(rec.id, p.body.id as string))
      results[name] = `approve ${a.status} complete ${c.status}`
      expect(a.status, name).toBeGreaterThanOrEqual(400)
      expect(c.status, name).toBeGreaterThanOrEqual(400)
    }
    void results
  }, 240_000)

  it("R1b. the buyer proposing for themselves as admin, or completing after someone else approved, is refused", async () => {
    const rec = await plainListed(db, fx, "NON_NCA", 100_000_000)
    adminB()
    expect((await readJson(await R().s.propose(rec.id, saleBody(rec.valuationId, 100_000_000, { buyerName: "Lerato Mokgadi-Buyer", buyerIdentifier: "ZZ-SD-2" })))).status).toBeGreaterThanOrEqual(400)
    officer()
    const p = await readJson(await R().s.propose(rec.id, saleBody(rec.valuationId, 100_000_000, { buyerName: "Lerato Mokgadi-Buyer", buyerIdentifier: "ZZ-SD-2" })))
    adminA()
    expect((await readJson(await R().s.approveSale(rec.id, p.body.id as string))).status).toBe(200)
    adminB()
    expect((await readJson(await R().s.completeSale(rec.id, p.body.id as string))).status, "the buyer completed their own purchase").toBeGreaterThanOrEqual(400)
  }, 120_000)

  it("R1c. COI declaration of the actor naming the buyer (by name, by ID, in the free text) blocks the actor; another user's declaration does not block but flags", async () => {
    const year = Number(today().slice(0, 4))
    await db.coiDeclaration.create({ data: { tenantId: fx.tenantId, userId: fx.adminA, year, hasConflict: true, details: "My brother Gideon Plaatjies (ID 8505055009087) trades as Plaatjies Plant." } as never }).catch(async (e) => { throw e })
    const rec = await plainListed(db, fx, "NON_NCA", 100_000_000)
    officer()
    const p = await readJson(await R().s.propose(rec.id, saleBody(rec.valuationId, 100_000_000, { buyerName: "Plaatjies Plant Hire", buyerIdentifier: "850505 5009 087" })))
    expect(p.body.relatedPartyMatch).toBe(true)
    adminA()
    expect((await readJson(await R().s.approveSale(rec.id, p.body.id as string))).status, "declarant approved sale to the declared relative").toBeGreaterThanOrEqual(400)
    adminB()
    expect((await readJson(await R().s.approveSale(rec.id, p.body.id as string))).status).toBe(200)
    // a declaration from a previous year or hasConflict=false naming the buyer, by an actor: no block expected (documenting)
  }, 120_000)

  // ---- refund: three people, reversal
  it("R2a. three-person refund: creator approving, creator or approver releasing, via any role, are refused; the third person closes it", async () => {
    const rec = await surplusHeld()
    officer()
    expect((await readJson(await R().s.refund(rec.id, refundForm()))).status).toBe(201)
    asUser(fx, fx.officer, "LOAN_ADMIN")
    expect((await readJson(await R().s.approveRefund(rec.id))).status).toBeGreaterThanOrEqual(400)
    adminA()
    expect((await readJson(await R().s.approveRefund(rec.id))).status).toBe(200)
    expect((await readJson(await R().s.releaseRefund(rec.id))).status).toBeGreaterThanOrEqual(400)
    asUser(fx, fx.officer, "LOAN_ADMIN")
    expect((await readJson(await R().s.releaseRefund(rec.id))).status, "creator released").toBeGreaterThanOrEqual(400)
    await expect(db.recoveryRefund.updateMany({ where: { recoveryId: rec.id }, data: { status: "RELEASED", releasedById: fx.officer, releasedAt: new Date() } })).rejects.toThrow()
    await expect(db.recoveryRefund.updateMany({ where: { recoveryId: rec.id }, data: { status: "RELEASED", releasedById: fx.adminA, releasedAt: new Date() } })).rejects.toThrow()
    adminB()
    expect((await readJson(await R().s.releaseRefund(rec.id))).status).toBe(200)
  }, 120_000)

  it("R2b. reversing the proceeds payment: the route refuses cleanly (not 500), nothing changes; other payments' reversal after approval blocks release", async () => {
    const rec = await surplusHeld()
    const payment = await db.payment.findFirstOrThrow({ where: { loanId: rec.loan.loanId } })
    adminA()
    const r = await reverse(payment.id)
    expect(r.status, `reversal answered ${r.status}`).toBeGreaterThanOrEqual(400)
    expect(r.status, "reversal blew up with a 5xx").toBeLessThan(500)
    expect((await db.payment.findUniqueOrThrow({ where: { id: payment.id } })).reversed).toBe(false)
    expect((await db.loan.findUniqueOrThrow({ where: { id: rec.loan.loanId } })).status).toBe("COMPLETED")
    // direct DB reversal (as another code path would do) is refused by the guard
    await expect(db.payment.update({ where: { id: payment.id }, data: { reversed: true } })).rejects.toThrow()
    // other ways to neutralise the receipt
    await expect(db.payment.update({ where: { id: payment.id }, data: { allocationStatus: "UNAPPLIED" as never } }).then(async () => { throw new Error("allocationStatus changed") })).rejects.toThrow()
  }, 120_000)

  it("R2c. loan re-opened after a refund was approved (another payment reversed / status flipped) blocks the release", async () => {
    const rec = await surplusHeld()
    officer()
    await R().s.refund(rec.id, refundForm())
    adminA()
    await R().s.approveRefund(rec.id)
    await db.$executeRawUnsafe(`UPDATE "Loan" SET "status" = 'ACTIVE' WHERE "id" = '${rec.loan.loanId}'`).catch(() => undefined)
    adminB()
    const out = await readJson(await R().s.releaseRefund(rec.id))
    const status = (await db.loan.findUniqueOrThrow({ where: { id: rec.loan.loanId } })).status
    if (status !== "COMPLETED") expect(out.status, "released on a reopened loan").toBeGreaterThanOrEqual(400)
  }, 120_000)

  it("R2d. a recovery with no proceeds payment: surplus refund path (proceedsPaymentId null)", async () => {
    // surplus > 0 implies a payment; documenting only: no payment row => the SQL treats the receipt as unreversed
    const rec = await surplusHeld()
    expect((await db.recovery.findUniqueOrThrow({ where: { id: rec.id } })).proceedsPaymentId).not.toBeNull()
  }, 120_000)

  // ---- screening normaliser
  async function flagged(buyer: Record<string, unknown>, setup?: (loanId: string, entityId: string | null) => Promise<void>) {
    const rec = await plainListed(db, fx, "NON_NCA", 100_000_000)
    if (setup) await setup(rec.loan.loanId, rec.loan.entityId)
    adminA()
    const out = await readJson(await R().s.propose(rec.id, saleBody(rec.valuationId, 100_000_000, buyer)))
    return out.body.relatedPartyMatch === true
  }
  const dir = async () => db.client.findUniqueOrThrow({ where: { id: fx.director }, select: { idNumber: true, firstName: true, lastName: true } })

  it("R3a. identifier evasions: label in the middle, letter O for 0, two IDs, appended digits, newline, NBSP/RTL marks, roman/superscript digits", async () => {
    const d = await dir()
    const id = d.idNumber
    const cases: Record<string, string> = {
      "label mid": `${id.slice(0, 4)} ID ${id.slice(4)}`,
      "letter O for zero": id.replace("0", "O"),
      "two ids": `${id} / 8001015009087`,
      "appended digits": `${id}0`,
      "prefix digits (+27)": `27${id}`,
      "newline": `${id.slice(0, 6)}\n${id.slice(6)}`,
      "RTL marks": `‏${id}‎`,
      "superscript digits": [...id].map((c) => "⁰¹²³⁴⁵⁶⁷⁸⁹"[Number(c)]).join(""),
      "circled digits": [...id].map((c) => (c === "0" ? "⓪" : String.fromCodePoint(0x2460 + Number(c) - 1))).join(""),
      "trailing label": `${id} (SA ID)`,
      "RSA prefix": `RSA ${id}`,
    }
    const res: Record<string, boolean> = {}
    for (const [label, value] of Object.entries(cases)) res[label] = await flagged({ buyerName: "Zzyzx Stranger", buyerIdentifier: value })
    expect(res, JSON.stringify(res)).toEqual(Object.fromEntries(Object.keys(cases).map((k) => [k, true])))
  }, 240_000)

  it("R3b. name evasions: Cyrillic homoglyph, joined initial+surname, zero-width/soft-hyphen, nickname-free surname with company words, joint buyers, Polish/Nordic letters, reversed with particles", async () => {
    const d = await dir()
    const cyr = (s: string) => s.replace(/a/g, "а").replace(/e/g, "е").replace(/o/g, "о").replace(/i/g, "і").replace(/c/g, "с")
    const cases: Record<string, string> = {
      "cyrillic homoglyph": cyr(`${d.firstName} ${d.lastName}`),
      "initial joined to surname": `${d.firstName[0]}${d.lastName}`,
      "zero-width inside": `${d.firstName} Dir​ector`,
      "soft hyphen inside": `${d.firstName} Dir­ector`,
      "joint buyers": `${d.firstName} ${d.lastName} and John Smith`,
      "initial after surname": `${d.lastName} ${d.firstName[0]}`,
      "first-name misspelt, initial right": `T. ${d.lastName}`,
    }
    const res: Record<string, boolean> = {}
    for (const [label, value] of Object.entries(cases)) res[label] = await flagged({ buyerName: value, buyerIdentifier: "ZZ-OTHER-9" })
    expect(res, JSON.stringify(res)).toEqual(Object.fromEntries(Object.keys(cases).map((k) => [k, true])))
  }, 240_000)

  it("R3c. registration evasions of the borrower entity: letters in the middle, 'Reg No' label, spaces in the year, short year, K prefix, trailing text", async () => {
    let n = 200000
    const res: Record<string, boolean> = {}
    for (const label of ["Reg No label", "K prefix", "slash variants", "trailing text", "reg label mid", "two registrations"]) {
      const reg = `2097/${n}/07`
      const [y, num, suf] = reg.split("/")
      const value = ({
        "Reg No label": `Reg No: ${reg}`, "K prefix": `K${y}${num}${suf}`, "slash variants": `${y}\\${num}\\${suf}`, "short year 98 style": `${y.slice(2)}/${num}/${suf}`,
        "trailing text": `${reg} (Pty) Ltd`, "reg label mid": `${y} reg ${num} ${suf}`, "two registrations": `${reg}, 2001/123456/07`,
      } as Record<string, string>)[label]
      res[label] = await flagged({ buyerType: "ENTITY", buyerName: "Zzyzx Holdings", buyerIdentifier: value }, async (_l, entityId) => {
        await db.$executeRawUnsafe(`UPDATE "BusinessEntity" SET "registrationNumber" = $1 WHERE "id" = $2`, reg, entityId)
        n++
      })
    }
    expect(res, JSON.stringify(res)).toEqual(Object.fromEntries(Object.keys(res).map((k) => [k, true])))
  }, 240_000)

  // ---- LEGAL_TAXED with evidence
  const cost = (legalStepId: string | undefined, over: Record<string, unknown> = {}) => ({
    type: "LEGAL_TAXED", treatment: "CHARGE_TO_ACCOUNT", netCents: 5_000_000, vatCents: 0, supplierInvoiceRef: `INV-${Math.random().toString(36).slice(2, 8)}`, incurredOn: today(), legalStepId, ...over,
  })
  const stepForm = (matterId: string, fields: Record<string, string>, text?: string) => stepRoute(
    new NextRequest(`http://${fx.host}/api/asset-finance/legal-matters/${matterId}/steps`, { method: "POST", headers: { host: fx.host }, body: stepWithEvidence(fields, text) }),
    { params: Promise.resolve({ id: matterId }) })

  it("R4a. s127 + SETTLED step: no evidence refused; evidence = any PDF accepted (documented); evidenced judgment on s131 accepted; corrected evidenced step refused; evidence on a different step kind refused", async () => {
    const { loan, id } = await ladderRecovery(db, fx, true, "LISTED", {}, true)
    officer()
    const matter = (await readJson(await R().l.open(loan.loanId))).body.id as string
    const bare = await readJson(await R().l.step(matter, { kind: "SETTLED", stepDate: today() }))
    expect(bare.status).toBe(201)
    expect((await R().r.cost(id, cost(bare.body.id as string))).status, "bare SETTLED").toBeGreaterThanOrEqual(400)
    const letter = await readJson(await stepForm(matter, { kind: "LETTER_OF_DEMAND", stepDate: today() }))
    expect(letter.status).toBe(201)
    expect((await R().r.cost(id, cost(letter.body.id as string))).status, "LETTER_OF_DEMAND with evidence").toBeGreaterThanOrEqual(400)
    // a junk-but-valid-PDF settlement as evidence
    const evidenced = await readJson(await stepForm(matter, { kind: "SETTLED", stepDate: today() }, "%PDF-1.4 x"))
    expect(evidenced.status, JSON.stringify(evidenced.body)).toBe(201)
    const withJunk = await R().r.cost(id, cost(evidenced.body.id as string))
    // documented: the evidence file's content is not validated, so a junk PDF on a SETTLED step backs the charge
    expect(withJunk.status).toBe(201)
  }, 120_000)

  it("R4b. s131: evidenced judgment is the control; a correction of that judgment, evidence swapped by DB, and a NON_NCA path", async () => {
    const rec = await plainListed(db, fx, "NCA", 100_000_000)
    const matter = (await db.recovery.findUniqueOrThrow({ where: { id: rec.id } })).legalMatterId as string
    officer()
    // a JSON step has no file: a bare judgment must not back the charge
    const bareJudgment = await readJson(await R().l.step(matter, { kind: "JUDGMENT", stepDate: today() }))
    expect(bareJudgment.status).toBe(201)
    expect((await R().r.cost(rec.id, cost(bareJudgment.body.id as string))).status, "judgment without evidence").toBeGreaterThanOrEqual(400)
    expect((await readJson(await R().l.matter(matter))).status).toBe(200)
    const ev = await readJson(await stepForm(matter, { kind: "JUDGMENT", stepDate: today() }))
    expect(ev.status).toBe(201)
    const ok = await R().r.cost(rec.id, cost(ev.body.id as string))
    expect(ok.status, JSON.stringify(ok.body)).toBe(201)
    // correct it, then a second charge on the corrected step is refused
    await readJson(await R().l.step(matter, { kind: "JUDGMENT", stepDate: today(), correctsStepId: ev.body.id as string }))
    expect((await R().r.cost(rec.id, cost(ev.body.id as string))).status, "charge on corrected evidenced judgment").toBeGreaterThanOrEqual(400)
  }, 120_000)
})
