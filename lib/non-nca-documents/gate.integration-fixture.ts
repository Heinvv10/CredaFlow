/**
 * Fixtures for the non-NCA document gate suites (gate.integration.test.ts): an
 * approved application, a lender's two CUSTOM templates, and the issuance rows a
 * real issue would write. Real Postgres; every value synthetic. Not a test file.
 */
import { createHash, randomUUID } from "node:crypto"
import type { PrismaClient } from "@prisma/client"
import { createChargesTenant, type ChargesTenant } from "@/lib/loan/charges.integration-fixture"

export const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex")

export const KFS_KEY = "non_nca_key_facts"
export const AGREEMENT_KEY = "non_nca_loan_agreement"
type Kind = "KEY_FACTS_STATEMENT" | "LOAN_AGREEMENT"
const KEY_OF: Record<Kind, string> = { KEY_FACTS_STATEMENT: KFS_KEY, LOAN_AGREEMENT: AGREEMENT_KEY }

export interface TemplateRef { templateId: string; versionId: string; version: number; bodyHtml: string }

/** A CUSTOM template with one ACTIVE, approved version (the lender's wording; here a placeholder). */
export async function createTemplate(db: PrismaClient, tenantId: string, key: string, bodyHtml = `<p>SAMPLE ${key} {{client.fullName}}</p>`): Promise<TemplateRef> {
  const template = await db.documentTemplate.create({
    data: { tenantId, key, name: key, kind: "CUSTOM", category: "Agreement", requiresApproval: true, isActive: true },
  })
  const version = await publishVersion(db, template.id, 1, bodyHtml)
  return { templateId: template.id, versionId: version.id, version: 1, bodyHtml }
}

/** A new ACTIVE approved version that becomes the template's current one; the previous one is ARCHIVED. */
export async function publishVersion(db: PrismaClient, templateId: string, version: number, bodyHtml: string) {
  await db.documentTemplateVersion.updateMany({ where: { templateId, status: "ACTIVE" }, data: { status: "ARCHIVED" } })
  const created = await db.documentTemplateVersion.create({
    data: {
      templateId, version, bodyHtml, tokensUsed: [], status: "ACTIVE",
      approvedById: "approver-test", approvedAt: new Date(), activatedById: "approver-test", activatedAt: new Date(),
    },
  })
  await db.documentTemplate.update({ where: { id: templateId }, data: { currentVersionId: created.id } })
  return created
}

export interface KeyFactsFixture {
  tenant: ChargesTenant
  /** A second staff member: the approver does not also disburse (segregation of duties). */
  disburserId: string
  clientId: string
  applicationId: string
  kfs: TemplateRef
  agreement: TemplateRef
}

/** A lender, a client and an APPROVED application (repaid by EFT), with both templates published. */
export async function createApprovedApplication(db: PrismaClient): Promise<KeyFactsFixture> {
  const tenant = await createChargesTenant(db, false)
  const n = randomUUID().replaceAll("-", "").slice(0, 10)
  const clientId = `c_kf_${n}`
  await db.client.create({ data: { id: clientId, tenantId: tenant.tenantId, idNumber: `X${n}`, firstName: "Thabo", lastName: "Synthetic", email: `${n}@client.invalid`, phone: "+26658000099" } })
  const application = await db.loanApplication.create({
    data: { tenantId: tenant.tenantId, reference: `APP-KF-${n}`, clientId, productId: tenant.productId, appliedAmount: 200_000, appliedTermDays: 31 },
  })
  await db.loanApplication.update({ where: { id: application.id }, data: { status: "SUBMITTED" } })
  await db.loanApplication.update({ where: { id: application.id }, data: { status: "UNDER_REVIEW" } })
  await db.loanApplication.update({
    where: { id: application.id },
    data: { status: "APPROVED", approvedAt: new Date(), approvedById: tenant.userId, approvedAmount: 200_000, approvedTermDays: 31, repaymentMethod: "EFT" },
  })
  const kfs = await createTemplate(db, tenant.tenantId, KFS_KEY)
  const agreement = await createTemplate(db, tenant.tenantId, AGREEMENT_KEY)
  const disburserId = `u_disb_${n}`
  await db.user.create({ data: { id: disburserId, tenantId: tenant.tenantId, email: `${n}-disb@test.invalid`, password: "x", role: "SUPER_ADMIN" } })
  return { tenant, disburserId, clientId, applicationId: application.id, kfs, agreement }
}

export const termsSha = async (db: PrismaClient, applicationId: string) =>
  (await db.$queryRaw<{ s: string }[]>`SELECT public."loanApplicationTermsSha256"(${applicationId}) AS s`)[0].s

/** What a real issue writes: the rendered document and its issuance row, bound to the template version. */
export async function issueDocument(db: PrismaClient, fx: KeyFactsFixture, kind: Kind, over: { template?: TemplateRef; bodyHtml?: string } = {}) {
  const template = over.template ?? (kind === "KEY_FACTS_STATEMENT" ? fx.kfs : fx.agreement)
  const pdfSha256 = sha(`${kind}:${randomUUID()}`)
  const document = await db.clientDocument.create({
    data: {
      tenantId: fx.tenant.tenantId, clientId: fx.clientId, docType: kind === "LOAN_AGREEMENT" ? "CREDIT_AGREEMENT" : "OTHER",
      fileName: `${kind}.pdf`, fileUrl: "", storagePath: `/synthetic/${randomUUID()}.pdf`, fileSize: 1, mimeType: "application/pdf",
      uploadedByType: "staff", extractionStatus: "skipped", verified: false, templateId: template.templateId,
      generatedFromVersionId: template.versionId, contentSha256: pdfSha256,
    },
  })
  const issuance = await db.loanDocumentIssuance.create({
    data: {
      tenantId: fx.tenant.tenantId, applicationId: fx.applicationId, kind, templateId: template.templateId, templateKey: KEY_OF[kind],
      templateVersionId: template.versionId, templateVersionNumber: template.version, templateContentSha256: sha(over.bodyHtml ?? template.bodyHtml),
      clientDocumentId: document.id, pdfSha256, termsSha256: await termsSha(db, fx.applicationId), issuedById: fx.tenant.userId,
    },
  })
  return { document, issuance, pdfSha256 }
}

/** Both documents issued, the key facts statement acknowledged by the borrower, the agreement bound to the application. */
export async function issueBoth(db: PrismaClient, fx: KeyFactsFixture, opts: { acknowledge?: boolean; bind?: boolean } = {}) {
  const kfs = await issueDocument(db, fx, "KEY_FACTS_STATEMENT")
  const agreement = await issueDocument(db, fx, "LOAN_AGREEMENT")
  if (opts.acknowledge !== false) {
    await db.loanDocumentIssuance.update({
      where: { id: kfs.issuance.id },
      data: { acknowledgedAt: new Date(), acknowledgedById: fx.clientId, acknowledgedSha256: kfs.pdfSha256 },
    })
  }
  if (opts.bind !== false) {
    await db.loanApplication.update({
      where: { id: fx.applicationId },
      data: { agreementGeneratedAt: new Date(), agreementDocumentId: agreement.document.id, agreementDocumentSha256: agreement.pdfSha256 },
    })
  }
  return { kfs, agreement }
}

export const signData = () => ({ agreementSignedAt: new Date(), agreementSignedMethod: "portal", agreementSignedByIp: "203.0.113.9", agreementSignatureData: "typed:Thabo Synthetic" })

/** DISBURSED with the loan booked in the same transaction (the database requires both to commit together). */
export async function disburse(db: PrismaClient, fx: KeyFactsFixture) {
  const n = randomUUID().replaceAll("-", "").slice(0, 12)
  return db.$transaction(async (tx) => {
    await tx.loan.create({
      data: {
        id: `l_kf_${n}`, tenantId: fx.tenant.tenantId, reference: `LN-KF-${n}`, applicationId: fx.applicationId, clientId: fx.clientId,
        productId: fx.tenant.productId, principal: 200_000, totalInterest: 10_000, initiationFee: 0, totalRepayable: 216_900, outstandingPrincipal: 200_000,
        startDate: new Date(), maturityDate: new Date(Date.now() + 31 * 86_400_000), interestRatePm: 0.05, interestModel: "FLAT", status: "ACTIVE", monthlyServiceFee: 6_900,
      },
    })
    await tx.loanApplication.update({ where: { id: fx.applicationId }, data: { status: "DISBURSED", disbursedAt: new Date(), disbursedById: fx.disburserId } })
    // Prisma can swallow an error the database raises at COMMIT: run the deferred checks now.
    await tx.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`
  })
}
