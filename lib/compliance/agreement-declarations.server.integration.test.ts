import { describe, expect, it } from "vitest"
import { prisma } from "@/lib/prisma"
import { createApprovedPasqV3Application } from "./pasq-v3-application.integration-fixture"
import { declarationEvidenceData, signatureDigest, assertDeclarationEvidence } from "./agreement-declarations.server"
const suite = process.env.RUN_DB_IT === "1" ? describe : describe.skip
suite("declaration evidence binding in PostgreSQL", () => {
  it("allows absent historical evidence, validates new rows, freezes them, and ignores mutable audit JSON", async () => {
    const s = await createApprovedPasqV3Application("gtm_f15", "DECLINED")
    const app = await prisma.loanApplication.findUniqueOrThrow({ where: { id: s.applicationId, tenantId: s.tenantId } })
    const binding = { tenantId: app.tenantId, applicationId: app.id, clientId: app.clientId!, signerId: app.clientId!, method: "portal", signedAt: app.agreementSignedAt!, agreementDocumentSha256: app.agreementDocumentSha256!, pasqDocumentSha256: app.pasqDocumentSha256!, signatureSha256: signatureDigest(app.agreementSignatureData!) }
    expect(await prisma.agreementDeclarationAcceptance.count({ where: { tenantId: app.tenantId, applicationId: app.id } })).toBe(0)
    const data = declarationEvidenceData(binding)
    for (const patch of [
      { acceptedIds: ["pasq_read"] }, { setSha256: "0".repeat(64) }, { version: "unsupported" }, { signerId: "wrong-client" }, { method: "branch" },
      { agreementDocumentSha256: "c".repeat(64) }, { pasqDocumentSha256: "c".repeat(64) }, { signatureSha256: "c".repeat(64) },
      { signedAt: new Date(binding.signedAt.getTime() + 1) }, { tenantId: "wrong-tenant" }, { clientId: "wrong-client" },
    ]) await expect(prisma.agreementDeclarationAcceptance.create({ data: { ...data, ...patch } })).rejects.toThrow()
    const record = await prisma.agreementDeclarationAcceptance.create({ data })
    expect(() => assertDeclarationEvidence(record, binding)).not.toThrow()
    await expect(prisma.agreementDeclarationAcceptance.create({ data })).rejects.toThrow(/Unique constraint/)
    await expect(prisma.agreementDeclarationAcceptance.update({ where: { id: record.id, tenantId: app.tenantId }, data: { acceptedIds: [] } })).rejects.toThrow(/immutable/)
    await expect(prisma.agreementDeclarationAcceptance.delete({ where: { id: record.id, tenantId: app.tenantId } })).rejects.toThrow(/immutable/)
    const audit = await prisma.auditLog.create({ data: { tenantId: app.tenantId, userEmail: "synthetic@example.test", action: "AGREEMENT_SIGNED", entity: "LoanApplication", entityId: app.id, newValue: { declarationAcceptanceId: record.id } } })
    await prisma.auditLog.update({ where: { id: audit.id, tenantId: app.tenantId }, data: { newValue: { acceptedIds: [] } } })
    expect(await prisma.agreementDeclarationAcceptance.findUniqueOrThrow({ where: { id: record.id, tenantId: app.tenantId } })).toMatchObject({ acceptedIds: data.acceptedIds, signatureSha256: binding.signatureSha256 })
  })
})
