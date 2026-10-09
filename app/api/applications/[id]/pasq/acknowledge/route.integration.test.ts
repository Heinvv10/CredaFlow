/**
 * Run only against a disposable, fully migrated PostgreSQL database:
 *
 *   RUN_PASQ_AUDIT_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run app/api/applications/[id]/pasq/acknowledge/route.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { describe, expect, it } from "vitest"
import { prisma } from "@/lib/prisma"

const suite = process.env.RUN_PASQ_AUDIT_IT === "1" ? describe : describe.skip

suite("client PASQ acknowledgement audit transaction", () => {
  it("commits the application acknowledgement and client-attributed audit without a staff User row", async () => {
    const token = randomUUID().replaceAll("-", "")
    const tenantId = `tenant_pasq_audit_${token}`
    const clientId = `client_pasq_audit_${token}`
    const productId = `product_pasq_audit_${token}`
    const applicationId = `application_pasq_audit_${token}`
    const documentId = `document_pasq_audit_${token}`
    const documentSha256 = "a".repeat(64)
    const evidenceSha256 = "b".repeat(64)
    const generatedAt = new Date("2026-07-24T08:00:00.000Z")
    const acknowledgedAt = new Date("2026-07-24T08:05:00.000Z")
    const clientEmail = `pasq-audit-${token}@example.invalid`

    await prisma.tenant.create({
      data: {
        id: tenantId,
        slug: `pasq-audit-${token}`,
        name: "PASQ audit integration",
      },
    })
    await prisma.loanProduct.create({
      data: {
        id: productId,
        tenantId,
        code: `PASQ-${token}`,
        name: "PASQ audit loan",
        productType: "MICRO",
        minAmount: 100_000,
        maxAmount: 1_000_000,
        minTermDays: 1,
        maxTermDays: 365,
        interestRatePm: 0.05,
        interestModel: "DAILY_ACCRUAL",
      },
    })
    await prisma.client.create({
      data: {
        id: clientId,
        tenantId,
        reference: `CLIENT-${token}`,
        idNumber: `PASQ-ID-${token}`,
        firstName: "Synthetic",
        lastName: "Client",
        email: clientEmail,
        phone: "+27820000000",
      },
    })
    await prisma.loanApplication.create({
      data: {
        id: applicationId,
        tenantId,
        reference: `APP-${token}`,
        clientId,
        productId,
        appliedAmount: 500_000,
        appliedTermDays: 30,
        status: "UNDER_REVIEW",
        pasqVersion: "pasq-v3",
        pasqGeneratedAt: generatedAt,
        pasqDocumentId: documentId,
        pasqDocumentSha256: documentSha256,
        pasqEvidence: {
          version: "pasq-v3",
          tenantId,
          applicationId,
          clientId,
          productId,
          evidenceSha256,
        },
        pasqEvidenceSha256: evidenceSha256,
      },
    })
    await prisma.clientDocument.create({
      data: {
        id: documentId,
        tenantId,
        clientId,
        docType: "FORM_20_PRE_AGREEMENT",
        fileUrl: `/api/applications/${applicationId}/pasq`,
        fileName: `pasq-${applicationId}.pdf`,
        fileSize: 4096,
        mimeType: "application/pdf",
        storagePath: `/tmp/pasq-${applicationId}.pdf`,
        contentSha256: documentSha256,
        extractionStatus: "skipped",
      },
    })

    const auditId = await prisma.$transaction(async (tx) => {
      const updated = await tx.loanApplication.updateMany({
        where: {
          id: applicationId,
          tenantId,
          status: "UNDER_REVIEW",
          pasqAcknowledgedAt: null,
          pasqAcknowledgedBy: null,
          pasqAcknowledgedSha256: null,
        },
        data: {
          pasqAcknowledgedAt: acknowledgedAt,
          pasqAcknowledgedBy: clientId,
          pasqAcknowledgedSha256: documentSha256,
        },
      })
      expect(updated.count).toBe(1)
      const audit = await tx.auditLog.create({
        data: {
          tenantId,
          userId: null,
          userEmail: clientEmail,
          action: "PASQ_ACKNOWLEDGED",
          entity: "LoanApplication",
          entityId: applicationId,
          newValue: {
            actorType: "client",
            actorClientId: clientId,
            documentId,
            documentSha256,
          },
        },
        select: { id: true },
      })
      return audit.id
    })

    const [storedApplication, storedAudit] = await Promise.all([
      prisma.loanApplication.findFirstOrThrow({
        where: { id: applicationId, tenantId },
        select: {
          pasqAcknowledgedAt: true,
          pasqAcknowledgedBy: true,
          pasqAcknowledgedSha256: true,
        },
      }),
      prisma.auditLog.findFirstOrThrow({
        where: { id: auditId, tenantId },
        select: { userId: true, userEmail: true, newValue: true },
      }),
    ])
    expect(storedApplication).toEqual({
      pasqAcknowledgedAt: acknowledgedAt,
      pasqAcknowledgedBy: clientId,
      pasqAcknowledgedSha256: documentSha256,
    })
    expect(storedAudit).toEqual({
      userId: null,
      userEmail: clientEmail,
      newValue: expect.objectContaining({
        actorType: "client",
        actorClientId: clientId,
      }),
    })
  })
})
