import { randomUUID } from "node:crypto"
import { describe, expect, it } from "vitest"
import { prisma } from "@/lib/prisma"
import { createApprovedPasqV3Application } from "./pasq-v3-application.integration-fixture"
import { declarationEvidenceData, signatureDigest, assertDeclarationEvidence } from "./agreement-declarations.server"
import { updateAuditRowsForTest } from "@/lib/audit/audit-rows.test-helpers"
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
    await updateAuditRowsForTest(prisma, { id: audit.id, tenantId: app.tenantId }, { newValue: { acceptedIds: [] } })
    expect(await prisma.agreementDeclarationAcceptance.findUniqueOrThrow({ where: { id: record.id, tenantId: app.tenantId } })).toMatchObject({ acceptedIds: data.acceptedIds, signatureSha256: binding.signatureSha256 })
  })
  it("isolates actual receipts with FORCE RLS under a non-bypass role", async () => {
    const s = await createApprovedPasqV3Application("gtm_f15_rls", "DECLINED")
    const app = await prisma.loanApplication.findUniqueOrThrow({ where: { id: s.applicationId, tenantId: s.tenantId } })
    const record = await prisma.agreementDeclarationAcceptance.create({ data: declarationEvidenceData({ tenantId: app.tenantId, applicationId: app.id, clientId: app.clientId!, signerId: app.clientId!, method: "portal", signedAt: app.agreementSignedAt!, agreementDocumentSha256: app.agreementDocumentSha256!, pasqDocumentSha256: app.pasqDocumentSha256!, signatureSha256: signatureDigest(app.agreementSignatureData!) }) })
    const role = `cf_f15_${randomUUID().replace(/-/g, "")}`
    await prisma.$executeRawUnsafe(`CREATE ROLE "${role}" NOLOGIN NOSUPERUSER NOBYPASSRLS`)
    try {
      await prisma.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO "${role}"`)
      await prisma.$executeRawUnsafe(`GRANT SELECT, INSERT ON "AgreementDeclarationAcceptance" TO "${role}"`)
      // SELECT FOR SHARE in the existing insert guard also requires UPDATE.
      await prisma.$executeRawUnsafe(`GRANT SELECT, UPDATE ON "LoanApplication" TO "${role}"`)
      const asTenant = async <T>(tenantId: string, work: (tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]) => Promise<T>) => prisma.$transaction(async tx => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE "${role}"`)
        await tx.$queryRaw`SELECT set_config('app.tenant_id', ${tenantId}, true), set_config('app.rls_bypass', 'off', true)`
        const [actualRole] = await tx.$queryRaw<{ superuser: boolean; bypass: boolean }[]>`SELECT rolsuper AS superuser, rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user`
        expect(actualRole).toEqual({ superuser: false, bypass: false })
        return work(tx)
      })
      const own = await asTenant(app.tenantId, tx => tx.$queryRaw<{ id: string }[]>`SELECT id FROM "AgreementDeclarationAcceptance" WHERE id = ${record.id}`)
      expect(own).toEqual([{ id: record.id }])
      const foreign = await asTenant("synthetic-other-tenant", tx => tx.$queryRaw<{ id: string }[]>`SELECT id FROM "AgreementDeclarationAcceptance" WHERE id = ${record.id}`)
      expect(foreign).toEqual([])
      const validBody = JSON.stringify({ ...record, id: randomUUID() })
      // BEFORE INSERT hides the foreign application and refuses binding before
      // WITH CHECK runs: this is layered rejection, not an asserted RLS 42501.
      await expect(asTenant("synthetic-other-tenant", tx => tx.$executeRaw`INSERT INTO "AgreementDeclarationAcceptance" SELECT (jsonb_populate_record(NULL::"AgreementDeclarationAcceptance", ${validBody}::jsonb)).*`)).rejects.toThrow(/must bind the current portal signature/)
      const [table] = await prisma.$queryRaw<{ enabled: boolean; forced: boolean }[]>`SELECT relrowsecurity AS enabled, relforcerowsecurity AS forced FROM pg_class WHERE oid = '"AgreementDeclarationAcceptance"'::regclass`
      expect(table).toEqual({ enabled: true, forced: true })
      const policies = await prisma.$queryRaw<{ name: string; using: string; check: string }[]>`SELECT policyname AS name, qual AS "using", with_check AS "check" FROM pg_policies WHERE schemaname = 'public' AND tablename = 'AgreementDeclarationAcceptance'`
      expect(policies).toHaveLength(1)
      expect(policies[0].name).toBe("tenant_isolation")
      const canonical = (sql: string) => sql.replace(/[\s()]/g, "")
      const expected = 'cf_rls_unrestrictedOR"tenantId"=cf_rls_tenant'
      expect(canonical(policies[0].using)).toBe(expected)
      expect(canonical(policies[0].check)).toBe(expected)
    } finally {
      await prisma.$executeRawUnsafe(`DROP OWNED BY "${role}"`)
      await prisma.$executeRawUnsafe(`DROP ROLE "${role}"`)
    }
  })

})
