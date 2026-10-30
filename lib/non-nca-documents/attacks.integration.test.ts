/**
 * Adversarial probes of PR #267 (non-NCA documents gate). Each `it` asserts the
 * CONTROL HOLDS; a red test is a break.
 *   RUN_DB_IT=1 DATABASE_URL=... npx vitest run lib/non-nca-documents/attacks.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createThrowawayDb, type ThrowawayDb } from "@/lib/jurisdiction/throwaway-db.integration-fixture"
import { createChargesTenant } from "@/lib/loan/charges.integration-fixture"
import {
  AGREEMENT_KEY, createApprovedApplication, disburse, issueBoth, issueDocument, sha, signData, termsSha, KFS_KEY, type KeyFactsFixture,
} from "./gate.integration-fixture"

const suite = process.env.RUN_DB_IT === "1" ? describe.sequential : describe.skip

suite("Adversarial (PR 267 round 1) LS instance", () => {
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
    
    expect(err).toBeInstanceOf(Error)
  })

  it("A2 template with requiresApproval=false: never-approved wording cannot be issued, signed or disbursed", async () => {
    const fx = await createApprovedApplication(db())
    // The control: a keyed template cannot be set to skip approval at all ...
    for (const t of [fx.kfs, fx.agreement]) {
      await expect(db().documentTemplate.update({ where: { id: t.templateId }, data: { requiresApproval: false } })).rejects.toThrow(/second person/)
    }
    // ... and, were the row altered behind the guard (triggers off), the gate does not read requiresApproval.
    await db().$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`)
      for (const t of [fx.kfs, fx.agreement]) {
        await tx.documentTemplate.update({ where: { id: t.templateId }, data: { requiresApproval: false } })
        await tx.documentTemplateVersion.update({ where: { id: t.versionId }, data: { approvedById: null, approvedAt: null } })
      }
    })
    await expect(issueBoth(db(), fx)).rejects.toThrow(/approved by someone other than its author/)
  })

  it("A3 KFS ClientDocument soft-deleted after acknowledgement: refused", async () => {
    const fx = await createApprovedApplication(db())
    const { kfs } = await issueBoth(db(), fx)
    await expect(db().clientDocument.update({ where: { id: kfs.document.id }, data: { deletedAt: new Date() } })).rejects.toThrow(/cannot be deleted/)
    // (the gate reading the file itself, with the guard bypassed, is H6)
  })

  it("A4 KFS + agreement file swapped (storagePath + contentSha256) after signing: refused", async () => {
    const fx = await createApprovedApplication(db())
    const { kfs, agreement } = await issueBoth(db(), fx)
    await db().loanApplication.update({ where: { id: fx.applicationId }, data: signData() })
    for (const d of [kfs.document, agreement.document]) {
      await expect(db().clientDocument.update({ where: { id: d.id }, data: { storagePath: `/synthetic/swapped-${randomUUID()}.pdf`, contentSha256: sha(`swapped:${d.id}`) } })).rejects.toThrow(/cannot be replaced/)
    }
    await disburse(db(), fx)
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

  it("A9 cross-tenant: issuance of tenant A's application pointing at tenant B's template is refused", async () => {
    const fx = await createApprovedApplication(db())
    const b = await createApprovedApplication(db())
    const doc = await issueDocument(db(), fx, "KEY_FACTS_STATEMENT", { template: b.kfs }).catch((e: Error) => e)
    expect(doc).toBeInstanceOf(Error)
  })
})

suite("Adversarial (PR 267 round 1) LS instance, hardening", () => {
  let fresh: ThrowawayDb
  const db = () => fresh.db
  beforeAll(async () => { fresh = await createThrowawayDb({ instance: { jurisdiction: "LS", currency: "LSL" } }) }, 240_000)
  afterAll(() => fresh?.drop())
  const approvedAt = () => ({ approvedById: "approver-test", approvedAt: new Date() })

  it("H1 the keyed templates cannot be set to skip approval, re-keyed or deleted; a plain template still can", async () => {
    const fx = await createApprovedApplication(db())
    await expect(db().documentTemplate.update({ where: { id: fx.kfs.templateId }, data: { requiresApproval: false } })).rejects.toThrow(/second person/)
    await expect(db().documentTemplate.update({ where: { id: fx.kfs.templateId }, data: { kind: "SYSTEM" } })).rejects.toThrow(/second person/)
    await expect(db().documentTemplate.update({ where: { id: fx.kfs.templateId }, data: { key: "renamed_key" } })).rejects.toThrow(/cannot be changed/)
    await expect(db().documentTemplate.update({ where: { id: fx.agreement.templateId }, data: { deletedAt: new Date() } })).rejects.toThrow(/cannot be deleted/)
    // Deactivating is allowed (a signed loan does not depend on it, H10), and an ordinary template is untouched.
    await db().documentTemplate.update({ where: { id: fx.kfs.templateId }, data: { isActive: false } })
    const plain = await db().documentTemplate.create({ data: { tenantId: fx.tenant.tenantId, key: "plain_letter", name: "x", kind: "CUSTOM", requiresApproval: false } })
    await db().documentTemplate.update({ where: { id: plain.id }, data: { deletedAt: new Date() } })
  })

  it("H2 a keyed template cannot be created without approval", async () => {
    const t = await createChargesTenant(db(), false)
    await expect(db().documentTemplate.create({ data: { tenantId: t.tenantId, key: "non_nca_key_facts", name: "k", kind: "CUSTOM", requiresApproval: false } })).rejects.toThrow(/second person/)
  })

  it("H3 a version approved by its own author (or by nobody) is not approved wording, whatever the template says", async () => {
    const fx = await createApprovedApplication(db())
    await issueBoth(db(), fx)
    await db().documentTemplateVersion.update({ where: { id: fx.agreement.versionId }, data: { approvedById: "author-test" } })
    await expect(db().loanApplication.update({ where: { id: fx.applicationId }, data: signData() })).rejects.toThrow(/someone other than its author/)
    await db().documentTemplateVersion.update({ where: { id: fx.agreement.versionId }, data: { createdById: null, ...approvedAt() } })
    await expect(db().loanApplication.update({ where: { id: fx.applicationId }, data: signData() })).rejects.toThrow(/someone other than its author/)
  })

  it("H4 a document cannot be issued from a version approved by its own author", async () => {
    const fx = await createApprovedApplication(db())
    await db().documentTemplateVersion.update({ where: { id: fx.kfs.versionId }, data: { approvedById: "author-test" } })
    await expect(issueDocument(db(), fx, "KEY_FACTS_STATEMENT")).rejects.toThrow(/someone other than its author/)
  })

  it("H5 a stored document cannot be hard-deleted or soft-deleted, nor its owner, origin or bytes changed, while an issuance references it", async () => {
    const fx = await createApprovedApplication(db())
    const { kfs } = await issueBoth(db(), fx)
    await expect(db().clientDocument.delete({ where: { id: kfs.document.id } })).rejects.toThrow(/cannot be deleted/)
    await expect(db().clientDocument.update({ where: { id: kfs.document.id }, data: { deletedAt: new Date() } })).rejects.toThrow(/cannot be deleted/)
    await expect(db().clientDocument.update({ where: { id: kfs.document.id }, data: { contentSha256: sha("x") } })).rejects.toThrow(/cannot be replaced/)
    await expect(db().clientDocument.update({ where: { id: kfs.document.id }, data: { storagePath: "/synthetic/other.pdf" } })).rejects.toThrow(/cannot be replaced/)
    await expect(db().clientDocument.update({ where: { id: kfs.document.id }, data: { issuedForApplicationId: "elsewhere" } })).rejects.toThrow(/cannot be replaced/)
    // Unrelated edits (a verification note) are not in the way.
    await db().clientDocument.update({ where: { id: kfs.document.id }, data: { verified: true } })
  })

  it("H6 the gate itself reads the stored file: a row altered behind the guards (triggers off) still stops the signature and the disbursement", async () => {
    const fx = await createApprovedApplication(db())
    const { kfs, agreement } = await issueBoth(db(), fx)
    const tamper = (sql: string) => db().$transaction(async (tx) => { await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`); await tx.$executeRawUnsafe(sql) })
    await tamper(`UPDATE "ClientDocument" SET "deletedAt" = now() WHERE id = '${kfs.document.id}'`)
    await expect(db().loanApplication.update({ where: { id: fx.applicationId }, data: signData() })).rejects.toThrow(/deleted, replaced or is not the one issued/)
    await tamper(`UPDATE "ClientDocument" SET "deletedAt" = NULL WHERE id = '${kfs.document.id}'`)
    await tamper(`UPDATE "ClientDocument" SET "contentSha256" = '${"b".repeat(64)}' WHERE id = '${agreement.document.id}'`)
    await expect(db().loanApplication.update({ where: { id: fx.applicationId }, data: signData() })).rejects.toThrow(/deleted, replaced or is not the one issued/)
    await tamper(`UPDATE "ClientDocument" SET "contentSha256" = '${agreement.pdfSha256}', "issuedForApplicationId" = 'another' WHERE id = '${agreement.document.id}'`)
    await expect(db().loanApplication.update({ where: { id: fx.applicationId }, data: signData() })).rejects.toThrow(/deleted, replaced or is not the one issued/)
  })

  it("H7 a document rendered for another application cannot be issued, even when it was never issued there", async () => {
    const fx = await createApprovedApplication(db())
    const orphan = await db().clientDocument.create({
      data: { tenantId: fx.tenant.tenantId, clientId: fx.clientId, docType: "OTHER", fileName: "o.pdf", fileUrl: "", storagePath: "/synthetic/o.pdf", fileSize: 1, mimeType: "application/pdf", uploadedByType: "staff", extractionStatus: "skipped", verified: false, templateId: fx.kfs.templateId, generatedFromVersionId: fx.kfs.versionId, contentSha256: sha("orphan"), issuedForApplicationId: "some-other-application" },
    })
    await expect(db().loanDocumentIssuance.create({
      data: {
        tenantId: fx.tenant.tenantId, applicationId: fx.applicationId, kind: "KEY_FACTS_STATEMENT", templateId: fx.kfs.templateId, templateKey: KFS_KEY, templateVersionId: fx.kfs.versionId, templateVersionNumber: 1,
        templateContentSha256: sha(fx.kfs.bodyHtml), clientDocumentId: orphan.id, pdfSha256: sha("orphan"), termsSha256: await termsSha(db(), fx.applicationId),
      },
    })).rejects.toThrow(/rendered for another application/)
  })

  it("H8 one UPDATE that changes the approved terms and signs (or disburses) is judged on the new terms", async () => {
    const signing = await createApprovedApplication(db())
    await issueBoth(db(), signing)
    await expect(db().loanApplication.update({ where: { id: signing.applicationId }, data: { ...signData(), approvedAmount: 900_000 } })).rejects.toThrow(/terms changed/)
    const disbursing = await createApprovedApplication(db())
    await issueBoth(db(), disbursing)
    await db().loanApplication.update({ where: { id: disbursing.applicationId }, data: signData() })
    await expect(db().$transaction(async (tx) => {
      await tx.loan.create({
        data: {
          id: `l_h8_${disbursing.applicationId.slice(-8)}`, tenantId: disbursing.tenant.tenantId, reference: `LN-H8-${disbursing.applicationId.slice(-8)}`, applicationId: disbursing.applicationId, clientId: disbursing.clientId,
          productId: disbursing.tenant.productId, principal: 200_000, totalInterest: 10_000, initiationFee: 0, totalRepayable: 216_900, outstandingPrincipal: 200_000, startDate: new Date(),
          maturityDate: new Date(Date.now() + 31 * 86_400_000), interestRatePm: 0.05, interestModel: "FLAT", status: "ACTIVE", monthlyServiceFee: 6_900,
        },
      })
      await tx.loanApplication.update({ where: { id: disbursing.applicationId }, data: { status: "DISBURSED", disbursedAt: new Date(), disbursedById: disbursing.disburserId, approvedAmount: 900_000 } })
    })).rejects.toThrow(/terms changed/)
  })

  it("H9 approval attribution of a key-facts application cannot be rewritten once it is approved", async () => {
    const fx = await createApprovedApplication(db())
    await expect(db().loanApplication.update({ where: { id: fx.applicationId }, data: { approvedById: fx.disburserId } })).rejects.toThrow(/Approval attribution is immutable/)
    await expect(db().loanApplication.update({ where: { id: fx.applicationId }, data: { approvedAt: new Date(0) } })).rejects.toThrow(/Approval attribution is immutable/)
  })

  it("H10 a signed loan is disbursed on the version it was issued from, whatever became of the template", async () => {
    const fx = await createApprovedApplication(db())
    await issueBoth(db(), fx)
    await db().loanApplication.update({ where: { id: fx.applicationId }, data: signData() })
    for (const t of [fx.kfs, fx.agreement]) await db().documentTemplate.update({ where: { id: t.templateId }, data: { isActive: false } })
    await db().documentTemplateVersion.updateMany({ where: { templateId: fx.agreement.templateId }, data: { status: "ARCHIVED" } })
    await disburse(db(), fx)
    expect((await db().loanApplication.findUniqueOrThrow({ where: { id: fx.applicationId } })).status).toBe("DISBURSED")
  })

  it("H11 the acknowledgement must be of the issued bytes: in the CHECK, and again in the gate when the CHECK is not there", async () => {
    const fx = await createApprovedApplication(db())
    const { kfs } = await issueBoth(db(), fx, { acknowledge: false })
    await expect(db().loanDocumentIssuance.update({ where: { id: kfs.issuance.id }, data: { acknowledgedAt: new Date(), acknowledgedById: fx.clientId, acknowledgedSha256: sha("other bytes") } })).rejects.toThrow(/LoanDocumentIssuance_acknowledgement_shape/)
  })
})

suite("Adversarial (PR 267 round 1) the gate's own acknowledgement check", () => {
  let fresh: ThrowawayDb
  const db = () => fresh.db
  beforeAll(async () => { fresh = await createThrowawayDb({ instance: { jurisdiction: "LS", currency: "LSL" } }) }, 240_000)
  afterAll(() => fresh?.drop())

  it("H12 with the CHECK taken away, the gate still refuses an acknowledgement of other bytes", async () => {
    const fx = await createApprovedApplication(db())
    const { kfs } = await issueBoth(db(), fx, { acknowledge: false })
    await db().$executeRawUnsafe(`ALTER TABLE "LoanDocumentIssuance" DROP CONSTRAINT "LoanDocumentIssuance_acknowledgement_shape"`)
    await db().loanDocumentIssuance.update({ where: { id: kfs.issuance.id }, data: { acknowledgedAt: new Date(), acknowledgedById: fx.clientId, acknowledgedSha256: sha("other bytes") } })
    await expect(db().loanApplication.update({ where: { id: fx.applicationId }, data: signData() })).rejects.toThrow(/has not been acknowledged/)
  })
})

suite("Adversarial (PR 267 round 1) ZA instance", () => {
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
