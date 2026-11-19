/**
 * Adversarial probes of PR #267 (non-NCA documents gate). Each `it` asserts the
 * CONTROL HOLDS; a red test is a break.
 *   RUN_DB_IT=1 DATABASE_URL=... npx vitest run lib/non-nca-documents/brk267.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createThrowawayDb, type ThrowawayDb } from "@/lib/jurisdiction/throwaway-db.integration-fixture"
import { createChargesTenant } from "@/lib/loan/charges.integration-fixture"
import {
  AGREEMENT_KEY, createApprovedApplication, disburse, issueBoth, issueDocument, sha, signData, KFS_KEY, type KeyFactsFixture,
} from "./gate.integration-fixture"

const suite = process.env.RUN_DB_IT === "1" ? describe.sequential : describe.skip

suite("BRK267 LS instance", () => {
  let fresh: ThrowawayDb
  const db = () => fresh.db
  beforeAll(async () => { fresh = await createThrowawayDb({ instance: { jurisdiction: "LS", currency: "LSL" } }) }, 240_000)
  afterAll(() => fresh?.drop())

  it("A1 INSERT straight into DISBURSED (signed, loan booked) with no documents is refused", async () => {
    const fx: KeyFactsFixture = await createApprovedApplication(db())
    const n = randomUUID().replaceAll("-", "").slice(0, 10)
    const attempt = db().$transaction(async (tx) => {
      const app = await tx.loanApplication.create({
        data: {
          tenantId: fx.tenant.tenantId, reference: `APP-RAW-${n}`, clientId: fx.clientId, productId: fx.tenant.productId,
          appliedAmount: 200_000, appliedTermDays: 31, status: "DISBURSED", approvedAt: new Date(), approvedById: fx.tenant.userId,
          approvedAmount: 200_000, approvedTermDays: 31, repaymentMethod: "EFT", disbursedAt: new Date(),
          ...signData(),
        },
      })
      await tx.loan.create({
        data: {
          id: `l_raw_${n}`, tenantId: fx.tenant.tenantId, reference: `LN-RAW-${n}`, applicationId: app.id, clientId: fx.clientId,
          productId: fx.tenant.productId, principal: 200_000, totalInterest: 10_000, initiationFee: 0, totalRepayable: 216_900, outstandingPrincipal: 200_000,
          startDate: new Date(), maturityDate: new Date(Date.now() + 31 * 86_400_000), interestRatePm: 0.05, interestModel: "FLAT", status: "ACTIVE", monthlyServiceFee: 6_900,
        },
      })
      await tx.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`
      return app.id
    })
    const err = await attempt.then(() => null, (e: Error) => e)
    process.stderr.write(`A1 REASON: ${err?.message.split('\n').slice(-3).join(' | ')}\n`)
    expect(err).toBeInstanceOf(Error)
  })

  it("A2 template with requiresApproval=false: never-approved wording is issued, signed and disbursed", async () => {
    const fx = await createApprovedApplication(db())
    for (const t of [fx.kfs, fx.agreement]) {
      await expect(db().documentTemplate.update({ where: { id: t.templateId }, data: { requiresApproval: false } })).rejects.toThrow()
      await db().documentTemplateVersion.update({ where: { id: t.versionId }, data: { approvedById: "author-test" } })
    }
    await expect(issueBoth(db(), fx)).rejects.toThrow()
  })

  it("A3 KFS ClientDocument soft-deleted after acknowledgement: sign + disburse still refused", async () => {
    const fx = await createApprovedApplication(db())
    const { kfs } = await issueBoth(db(), fx)
    await db().clientDocument.update({ where: { id: kfs.document.id }, data: { deletedAt: new Date() } })
    await expect(db().loanApplication.update({ where: { id: fx.applicationId }, data: signData() })).rejects.toThrow()
  })

  it("A4 KFS + agreement file swapped (storagePath + contentSha256) after signing: disbursement refused", async () => {
    const fx = await createApprovedApplication(db())
    const { kfs, agreement } = await issueBoth(db(), fx)
    await db().loanApplication.update({ where: { id: fx.applicationId }, data: signData() })
    for (const d of [kfs.document, agreement.document]) {
      await db().clientDocument.update({ where: { id: d.id }, data: { storagePath: `/synthetic/swapped-${randomUUID()}.pdf`, contentSha256: sha(`swapped:${d.id}`) } })
    }
    await expect(disburse(db(), fx)).rejects.toThrow()
  })

  it("A5 a document rendered for ANOTHER application of the same borrower is issued for this one", async () => {
    const fx = await createApprovedApplication(db())
    // Second application, same client, same terms, approved.
    const p2 = `p2_${randomUUID().slice(0, 8)}`
    const cols = (await db().$queryRawUnsafe<{ c: string }[]>(`SELECT string_agg(quote_ident(column_name), ',') c FROM information_schema.columns WHERE table_name='LoanProduct' AND column_name NOT IN ('id','code','name')`))[0].c
    await db().$executeRawUnsafe(`INSERT INTO "LoanProduct" (id, code, name, ${cols}) SELECT '${p2}', '${p2}', '${p2}', ${cols} FROM "LoanProduct" WHERE id='${fx.tenant.productId}'`)
    const other = await db().loanApplication.create({
      data: { tenantId: fx.tenant.tenantId, reference: `APP-OTHER-${randomUUID().slice(0, 8)}`, clientId: fx.clientId, productId: p2, appliedAmount: 200_000, appliedTermDays: 31 },
    })
    for (const s of ["SUBMITTED", "UNDER_REVIEW"] as const) await db().loanApplication.update({ where: { id: other.id }, data: { status: s } })
    await db().loanApplication.update({ where: { id: other.id }, data: { status: "APPROVED", approvedAt: new Date(), approvedById: fx.tenant.userId, approvedAmount: 200_000, approvedTermDays: 31, repaymentMethod: "EFT" } })
    const forOther = await issueDocument(db(), { ...fx, applicationId: other.id }, "KEY_FACTS_STATEMENT")
    // Re-use the OTHER application's KFS file for fx.
    const reuse = db().loanDocumentIssuance.create({
      data: {
        tenantId: fx.tenant.tenantId, applicationId: fx.applicationId, kind: "KEY_FACTS_STATEMENT", templateId: fx.kfs.templateId, templateKey: KFS_KEY,
        templateVersionId: fx.kfs.versionId, templateVersionNumber: 1, templateContentSha256: sha(fx.kfs.bodyHtml),
        clientDocumentId: forOther.document.id, pdfSha256: forOther.pdfSha256,
        termsSha256: (await db().$queryRaw<{ s: string }[]>`SELECT public."loanApplicationTermsSha256ById"(${fx.applicationId}) AS s`)[0].s,
        issuedById: fx.tenant.userId,
      },
    })
    await expect(reuse).rejects.toThrow()
    // Forge the binding: a NEW ClientDocument row over OTHER's file and bytes, claiming it was rendered for fx.
    const forged = await db().clientDocument.create({ data: {
      tenantId: fx.tenant.tenantId, clientId: fx.clientId, docType: "OTHER", fileName: "forged.pdf", fileUrl: "", storagePath: forOther.document.storagePath,
      fileSize: 1, mimeType: "application/pdf", uploadedByType: "staff", extractionStatus: "skipped", verified: false,
      templateId: fx.kfs.templateId, generatedFromVersionId: fx.kfs.versionId, contentSha256: forOther.pdfSha256, issuedForApplicationId: fx.applicationId } })
    const forgedIssue = db().loanDocumentIssuance.create({ data: {
      tenantId: fx.tenant.tenantId, applicationId: fx.applicationId, kind: "KEY_FACTS_STATEMENT", templateId: fx.kfs.templateId, templateKey: KFS_KEY,
      templateVersionId: fx.kfs.versionId, templateVersionNumber: 1, templateContentSha256: sha(fx.kfs.bodyHtml),
      clientDocumentId: forged.id, pdfSha256: forOther.pdfSha256,
      termsSha256: (await db().$queryRaw<{ s: string }[]>`SELECT public."loanApplicationTermsSha256ById"(${fx.applicationId}) AS s`)[0].s, issuedById: fx.tenant.userId } })
    await expect(forgedIssue, "A5b forged issuedForApplicationId at insert").rejects.toThrow()
    void AGREEMENT_KEY
  })

  it("A6 approved terms changed on a SIGNED application, then disbursed: refused", async () => {
    const fx = await createApprovedApplication(db())
    await issueBoth(db(), fx)
    await db().loanApplication.update({ where: { id: fx.applicationId }, data: signData() })
    await db().loanApplication.update({ where: { id: fx.applicationId }, data: { approvedAmount: 900_000 } })
    await expect(disburse(db(), fx)).rejects.toThrow(/terms changed/)
  })

  it("A7 acknowledgement on different bytes is refused", async () => {
    const fx = await createApprovedApplication(db())
    const { kfs } = await issueBoth(db(), fx, { acknowledge: false })
    await expect(db().loanDocumentIssuance.update({ where: { id: kfs.issuance.id }, data: { acknowledgedAt: new Date(), acknowledgedById: fx.clientId, acknowledgedSha256: sha("other bytes") } })).rejects.toThrow()
    await expect(db().loanDocumentIssuance.update({ where: { id: kfs.issuance.id }, data: { acknowledgedAt: new Date(), acknowledgedById: "staff-user", acknowledgedSha256: kfs.pdfSha256 } })).rejects.toThrow()
  })

  it("A8 template republished after issue: signing refused", async () => {
    const fx = await createApprovedApplication(db())
    await issueBoth(db(), fx)
    await db().documentTemplateVersion.updateMany({ where: { templateId: fx.agreement.templateId, status: "ACTIVE" }, data: { status: "ARCHIVED" } })
    const v2 = await db().documentTemplateVersion.create({ data: { templateId: fx.agreement.templateId, version: 2, bodyHtml: "<p>v2</p>", tokensUsed: [], status: "ACTIVE", approvedById: "a", approvedAt: new Date() } })
    await db().documentTemplate.update({ where: { id: fx.agreement.templateId }, data: { currentVersionId: v2.id } })
    await expect(db().loanApplication.update({ where: { id: fx.applicationId }, data: signData() })).rejects.toThrow(/no longer the current/)
  })

  it("N1 a DISBURSED key-facts application cannot be rolled back to UNDER_REVIEW, unsigned and re-papered", async () => {
    const fx = await createApprovedApplication(db())
    await issueBoth(db(), fx)
    await db().loanApplication.update({ where: { id: fx.applicationId }, data: signData() })
    await disburse(db(), fx)
    const back = Promise.all((["CANCELLED", "APPROVED", "DECLINED"] as const).map((st) => db().$transaction(async (tx) => {
      await tx.loanApplication.update({ where: { id: fx.applicationId }, data: { status: st } })
      await tx.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`
    }).then(() => { throw new Error(`ACCEPTED ${st}`) }, (e: Error) => { if (/ACCEPTED/.test(e.message)) throw e; return e })))
    const err = await back.then(() => new Error('all refused'), (e: Error) => { process.stderr.write(`N1 BROKEN ${e.message}\n`); return null })
    if (!err) {
      const n = await db().loanDocumentIssuance.updateMany({ where: { applicationId: fx.applicationId, supersededAt: null }, data: { supersededAt: new Date() } }).catch((e: Error) => e)
      await db().loanApplication.update({ where: { id: fx.applicationId }, data: { approvedAmount: 999_000 } }).catch(() => undefined)
      const loan = await db().loan.findFirst({ where: { applicationId: fx.applicationId } })
      const app = await db().loanApplication.findUniqueOrThrow({ where: { id: fx.applicationId } })
      process.stderr.write(`N1 ROLLBACK ACCEPTED: status=${app.status} signed=${app.agreementSignedAt} approvedAmount=${app.approvedAmount} loan=${loan?.id} superseded=${JSON.stringify(n)}\n`)
    }
    process.stderr.write(`N1 REASON: ${(err?.message ?? "").split("PostgresError")[1]?.replace(/\s+/g, " ").slice(0, 300)}\n`)
    expect(err).toBeInstanceOf(Error)
  })

  it("A9 cross-tenant: issuance of tenant A's application pointing at tenant B's template is refused", async () => {
    const fx = await createApprovedApplication(db())
    const b = await createApprovedApplication(db())
    const doc = await issueDocument(db(), fx, "KEY_FACTS_STATEMENT", { template: b.kfs }).catch((e: Error) => e)
    expect(doc).toBeInstanceOf(Error)
  })
})

suite("BRK267 ZA instance", () => {
  let fresh: ThrowawayDb
  const db = () => fresh.db
  beforeAll(async () => { fresh = await createThrowawayDb({ instance: { jurisdiction: "ZA", currency: "ZAR" } }) }, 240_000)
  afterAll(() => fresh?.drop())

  it("Z1 raw SQL insert naming KEY_FACTS, and later UPDATE to KEY_FACTS, both end NCA_PASQ / refused", async () => {
    const t = await createChargesTenant(db(), false)
    const n = randomUUID().replaceAll("-", "").slice(0, 10)
    await db().client.create({ data: { id: `c_${n}`, tenantId: t.tenantId, idNumber: `Z${n}`, firstName: "A", lastName: "Synthetic", email: `${n}@c.invalid`, phone: "+27820000000" } })
    await db().$executeRawUnsafe(`INSERT INTO "LoanApplication" ("id","tenantId","reference","clientId","productId","appliedAmount","appliedTermDays","disclosureRegime","updatedAt") VALUES ('a_${n}','${t.tenantId}','R-${n}','c_${n}','${t.productId}',200000,31,'KEY_FACTS',now())`)
    const row = await db().$queryRawUnsafe<{ r: string }[]>(`SELECT "disclosureRegime"::text r FROM "LoanApplication" WHERE id='a_${n}'`)
    expect(row[0].r).toBe("NCA_PASQ")
    await expect(db().$executeRawUnsafe(`UPDATE "LoanApplication" SET "disclosureRegime"='KEY_FACTS' WHERE id='a_${n}'`)).rejects.toThrow(/fixed/)
    // Jurisdiction cannot be switched under an existing application.
    await expect(db().$executeRawUnsafe(`UPDATE "InstanceJurisdiction" SET "jurisdiction"='LS', "currency"='LSL' WHERE id=1`)).rejects.toThrow()
    // Even after deleting every application, the frozen instance stays frozen.
    await expect(db().$executeRawUnsafe(`DELETE FROM "InstanceJurisdiction"`)).rejects.toThrow()
  })

  it("Z2 an issuance row cannot be written for a ZA application", async () => {
    const t = await createChargesTenant(db(), false)
    const n = randomUUID().replaceAll("-", "").slice(0, 10)
    await db().client.create({ data: { id: `c2_${n}`, tenantId: t.tenantId, idNumber: `Z2${n}`, firstName: "A", lastName: "Synthetic", email: `2${n}@c.invalid`, phone: "+27820000001" } })
    const app = await db().loanApplication.create({ data: { tenantId: t.tenantId, reference: `R2-${n}`, clientId: `c2_${n}`, productId: t.productId, appliedAmount: 200_000, appliedTermDays: 31 } })
    await expect(db().$executeRawUnsafe(`INSERT INTO "LoanDocumentIssuance" ("id","tenantId","applicationId","kind","templateId","templateKey","templateVersionId","templateVersionNumber","templateContentSha256","clientDocumentId","pdfSha256","termsSha256") VALUES ('x','${t.tenantId}','${app.id}','KEY_FACTS_STATEMENT','t','non_nca_key_facts','v',1,'${"a".repeat(64)}','d','${"a".repeat(64)}','${"a".repeat(64)}')`)).rejects.toThrow()
  })
})
