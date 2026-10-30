/**
 * Real-Postgres proof of the non-NCA document gate (migration
 * 20261030090000_non_nca_documents): a KEY_FACTS application (a non-NCA
 * instance) cannot be signed or disbursed without BOTH a key facts statement and
 * a loan agreement issued from the lender's current approved template versions;
 * a template change after issue is caught; a South African application still
 * needs its PASQ.
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/non-nca-documents/gate.integration.test.ts
 *
 * Each suite runs in its own throwaway database (the instance jurisdiction is a
 * property of the whole database). The role needs CREATEDB.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createThrowawayDb, type ThrowawayDb } from "@/lib/jurisdiction/throwaway-db.integration-fixture"
import {
  createApprovedApplication, disburse, issueBoth, issueDocument, publishVersion, sha, signData, termsSha, type KeyFactsFixture,
} from "./gate.integration-fixture"

const suite = process.env.RUN_DB_IT === "1" ? describe.sequential : describe.skip
const SIGN_REFUSED = /cannot be signed/
const DISBURSE_REFUSED = /cannot be disbursed/

suite("a Lesotho (KEY_FACTS) instance (real DB)", () => {
  let fresh: ThrowawayDb
  const db = () => fresh.db
  const fresh1 = (): Promise<KeyFactsFixture> => createApprovedApplication(db())

  beforeAll(async () => { fresh = await createThrowawayDb({ instance: { jurisdiction: "LS", currency: "LSL" } }) }, 240_000)
  afterAll(() => fresh?.drop())

  it("stamps KEY_FACTS on every application from the instance, whatever the writer sent, and never lets it change", async () => {
    const fx = await fresh1()
    const row = await db().loanApplication.findUniqueOrThrow({ where: { id: fx.applicationId } })
    expect(row.disclosureRegime).toBe("KEY_FACTS")
    const second = `c_kf2_${sha(fx.applicationId).slice(0, 8)}`
    await db().client.create({ data: { id: second, tenantId: fx.tenant.tenantId, idNumber: `Y${second}`, firstName: "Palesa", lastName: "Synthetic", email: `${second}@client.invalid`, phone: "+26662000098" } })
    const other = await db().loanApplication.create({
      data: { tenantId: fx.tenant.tenantId, reference: `APP-X-${second}`, clientId: second, productId: fx.tenant.productId, appliedAmount: 100_000, appliedTermDays: 31, disclosureRegime: "NCA_PASQ" },
    })
    expect(other.disclosureRegime).toBe("KEY_FACTS")
    await expect(db().loanApplication.update({ where: { id: fx.applicationId }, data: { disclosureRegime: "NCA_PASQ" } })).rejects.toThrow(/disclosure regime is fixed/)
  })

  it("an application reaches APPROVED with no PASQ, no credit-life election and no insurer", async () => {
    const fx = await fresh1()
    expect((await db().loanApplication.findUniqueOrThrow({ where: { id: fx.applicationId } })).status).toBe("APPROVED")
  })

  it("cannot be signed with nothing issued, with only one document, or with the statement unacknowledged", async () => {
    const fx = await fresh1()
    const sign = () => db().loanApplication.update({ where: { id: fx.applicationId }, data: signData() })
    await expect(sign()).rejects.toThrow(SIGN_REFUSED)
    await expect(sign()).rejects.toThrow(/no key facts statement has been issued/)
    const kfs = await issueDocument(db(), fx, "KEY_FACTS_STATEMENT")
    await expect(sign()).rejects.toThrow(/no loan agreement has been issued/)
    const agreement = await issueDocument(db(), fx, "LOAN_AGREEMENT")
    await db().loanApplication.update({ where: { id: fx.applicationId }, data: { agreementGeneratedAt: new Date(), agreementDocumentId: agreement.document.id, agreementDocumentSha256: agreement.pdfSha256 } })
    await expect(sign()).rejects.toThrow(/key facts statement has not been acknowledged/)
    await db().loanDocumentIssuance.update({ where: { id: kfs.issuance.id }, data: { acknowledgedAt: new Date(), acknowledgedById: fx.clientId, acknowledgedSha256: kfs.pdfSha256 } })
    await sign()
    expect((await db().loanApplication.findUniqueOrThrow({ where: { id: fx.applicationId } })).agreementSignedAt).not.toBeNull()
  })

  it("cannot sign an agreement that is not the issued one", async () => {
    const fx = await fresh1()
    await issueBoth(db(), fx, { bind: false })
    const stray = await issueDocument(db(), { ...fx, applicationId: fx.applicationId }, "LOAN_AGREEMENT").catch((e: Error) => e)
    expect(stray).toBeInstanceOf(Error) // one standing agreement at a time
    const other = await db().clientDocument.create({
      data: { tenantId: fx.tenant.tenantId, clientId: fx.clientId, docType: "CREDIT_AGREEMENT", fileName: "other.pdf", fileUrl: "", storagePath: "/synthetic/other.pdf", fileSize: 1, mimeType: "application/pdf", uploadedByType: "staff", extractionStatus: "skipped", verified: false },
    })
    await db().loanApplication.update({ where: { id: fx.applicationId }, data: { agreementGeneratedAt: new Date(), agreementDocumentId: other.id, agreementDocumentSha256: sha("other") } })
    await expect(db().loanApplication.update({ where: { id: fx.applicationId }, data: signData() })).rejects.toThrow(/not the issued loan agreement/)
  })

  it("catches a template change after issue: edited wording, and a newer version, both stop the signature", async () => {
    const edited = await fresh1()
    await issueBoth(db(), edited)
    await db().documentTemplateVersion.update({ where: { id: edited.agreement.versionId }, data: { bodyHtml: "<p>quietly changed</p>" } })
    await expect(db().loanApplication.update({ where: { id: edited.applicationId }, data: signData() })).rejects.toThrow(/wording of template version 1 changed after the loan agreement was issued/)

    const newer = await fresh1()
    await issueBoth(db(), newer)
    await publishVersion(db(), newer.kfs.templateId, 2, "<p>SAMPLE v2 {{client.fullName}}</p>")
    await expect(db().loanApplication.update({ where: { id: newer.applicationId }, data: signData() })).rejects.toThrow(/no longer the current approved version; issue the key facts statement again/)
  })

  it("refuses a version that was never approved, and a template taken out of use", async () => {
    const fx = await fresh1()
    await issueBoth(db(), fx)
    await db().documentTemplateVersion.update({ where: { id: fx.agreement.versionId }, data: { approvedById: null, approvedAt: null } })
    await expect(db().loanApplication.update({ where: { id: fx.applicationId }, data: signData() })).rejects.toThrow(/was never approved/)
    await db().documentTemplateVersion.update({ where: { id: fx.agreement.versionId }, data: { approvedById: "approver-test", approvedAt: new Date() } })
    await db().documentTemplate.update({ where: { id: fx.agreement.templateId }, data: { isActive: false } })
    await expect(db().loanApplication.update({ where: { id: fx.applicationId }, data: signData() })).rejects.toThrow(/template is not in use/)
  })

  it("catches approved terms that changed after the documents were issued", async () => {
    const fx = await fresh1()
    await issueBoth(db(), fx)
    await db().loanApplication.update({ where: { id: fx.applicationId }, data: { approvedAmount: 250_000 } })
    expect(await termsSha(db(), fx.applicationId)).not.toBe((await db().loanDocumentIssuance.findFirstOrThrow({ where: { applicationId: fx.applicationId, kind: "LOAN_AGREEMENT" } })).termsSha256)
    await expect(db().loanApplication.update({ where: { id: fx.applicationId }, data: signData() })).rejects.toThrow(/approved terms changed/)
  })

  it("cannot be disbursed unsigned, or without the documents; a signed one is disbursed", async () => {
    const unsigned = await fresh1()
    await issueBoth(db(), unsigned)
    await expect(db().loanApplication.update({ where: { id: unsigned.applicationId }, data: { status: "DISBURSED", disbursedAt: new Date(), disbursedById: unsigned.disburserId } })).rejects.toThrow(/before the borrower has signed/)

    const fx = await fresh1()
    await issueBoth(db(), fx)
    await db().loanApplication.update({ where: { id: fx.applicationId }, data: signData() })
    // The documents are retracted behind the signature (superseding a signed application's documents is itself refused).
    await expect(db().loanDocumentIssuance.updateMany({ where: { applicationId: fx.applicationId }, data: { supersededAt: new Date() } })).rejects.toThrow(/cannot be superseded/)
    await disburse(db(), fx)
    expect((await db().loanApplication.findUniqueOrThrow({ where: { id: fx.applicationId } })).status).toBe("DISBURSED")
  })

  it("DISBURSED re-checks the documents: wording edited after signing is caught, a newer version after signing is not", async () => {
    const newer = await fresh1()
    await issueBoth(db(), newer)
    await db().loanApplication.update({ where: { id: newer.applicationId }, data: signData() })
    await publishVersion(db(), newer.agreement.templateId, 2, "<p>SAMPLE v2</p>")
    await disburse(db(), newer)

    const edited = await fresh1()
    await issueBoth(db(), edited)
    await db().loanApplication.update({ where: { id: edited.applicationId }, data: signData() })
    await db().documentTemplateVersion.update({ where: { id: edited.kfs.versionId }, data: { bodyHtml: "<p>edited after signing</p>" } })
    await expect(disburse(db(), edited)).rejects.toThrow(DISBURSE_REFUSED)
  })

  it("the issuance rows are immutable, and the SAMPLE flag follows the lender, not the writer", async () => {
    const fx = await fresh1()
    const { issuance } = await issueDocument(db(), fx, "KEY_FACTS_STATEMENT")
    expect(issuance.sample).toBe(false)
    await expect(db().loanDocumentIssuance.update({ where: { id: issuance.id }, data: { pdfSha256: sha("x") } })).rejects.toThrow(/immutable/)
    await expect(db().loanDocumentIssuance.delete({ where: { id: issuance.id } })).rejects.toThrow(/cannot be deleted/)
    await expect(db().loanDocumentIssuance.update({ where: { id: issuance.id }, data: { acknowledgedAt: new Date(), acknowledgedById: "someone-else", acknowledgedSha256: issuance.pdfSha256 } })).rejects.toThrow(/acknowledged by the borrower/)
    await db().tenantConfig.update({ where: { tenantId: fx.tenant.tenantId }, data: { isDemoLender: true } })
    await db().loanDocumentIssuance.update({ where: { id: issuance.id }, data: { supersededAt: new Date() } })
    const demo = await issueDocument(db(), fx, "KEY_FACTS_STATEMENT")
    expect(demo.issuance.sample).toBe(true)
  })

  it("refuses an issuance that was not rendered from the current approved version of the template", async () => {
    const fx = await fresh1()
    await publishVersion(db(), fx.kfs.templateId, 2, "<p>v2</p>")
    await expect(issueDocument(db(), fx, "KEY_FACTS_STATEMENT")).rejects.toThrow(/current approved version of its template/)
    await expect(issueDocument(db(), fx, "KEY_FACTS_STATEMENT", { template: { ...fx.kfs, versionId: (await db().documentTemplate.findUniqueOrThrow({ where: { id: fx.kfs.templateId } })).currentVersionId!, version: 2 }, bodyHtml: "<p>not v2</p>" })).rejects.toThrow(/wording of its template version/)
  })
})

suite("a South African (NCA_PASQ) instance (real DB)", () => {
  let fresh: ThrowawayDb
  const db = () => fresh.db

  beforeAll(async () => { fresh = await createThrowawayDb() }, 240_000)
  afterAll(() => fresh?.drop())

  it("stamps NCA_PASQ, and the PASQ is still required to approve, sign and disburse", async () => {
    const { createChargesTenant } = await import("@/lib/loan/charges.integration-fixture")
    const t = await createChargesTenant(db(), false)
    const clientId = `c_za_${sha(t.tenantId).slice(0, 10)}`
    await db().client.create({ data: { id: clientId, tenantId: t.tenantId, idNumber: `Z${clientId.slice(5)}`, firstName: "Za", lastName: "Synthetic", email: `${clientId}@client.invalid`, phone: "0820000099" } })
    const app = await db().loanApplication.create({
      data: { tenantId: t.tenantId, reference: `APP-ZA-${clientId.slice(5)}`, clientId, productId: t.productId, appliedAmount: 200_000, appliedTermDays: 31, disclosureRegime: "KEY_FACTS" },
    })
    expect(app.disclosureRegime).toBe("NCA_PASQ")
    await db().loanApplication.update({ where: { id: app.id }, data: { status: "SUBMITTED" } })
    await db().loanApplication.update({ where: { id: app.id }, data: { status: "UNDER_REVIEW" } })
    // No PASQ, no credit-life election: the same refusal as before this change.
    await expect(db().loanApplication.update({
      where: { id: app.id }, data: { status: "APPROVED", approvedAt: new Date(), approvedById: t.userId, approvedAmount: 200_000, approvedTermDays: 31, repaymentMethod: "EFT" },
    })).rejects.toThrow(/credit-life product|PASQ/)
    // And a signature on an unapproved South African application, with no PASQ, is not made reachable by this change.
    await expect(db().loanApplication.update({ where: { id: app.id }, data: { status: "DISBURSED", disbursedAt: new Date(), disbursedById: t.userId } })).rejects.toThrow(/PASQ|status|check|credit-life/)
  })
})
