import { NextRequest, NextResponse } from "next/server"
import { getLenderBrandName } from "@/lib/config/identity"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { prisma } from "@/lib/prisma"
import { sendSms } from "@/lib/integrations/bulksms"
import { disburseFunds } from "@/lib/integrations/netcash"
import { getCreditReport } from "@/lib/integrations/transunion"
import { verifyId } from "@/lib/integrations/smileidentity"
import { getAvsProvider } from "@/lib/integrations/collections/registry"

export async function POST(req: NextRequest) {
  const guard = await requireApiRole("ADMIN")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const body = await req.json()
    const provider = body.provider as string

    try {
      switch (provider) {
        case "bulksms": {
          const phone = body.phone ?? "+27000000000"
          const result = await sendSms({
            tenantId: tenant.id,
            to: phone,
            message: `${await getLenderBrandName(tenant.id)} test message`,
          })
          return NextResponse.json(result)
        }
        case "netcash": {
          const result = await disburseFunds({
            tenantId: tenant.id,
            accountHolder: "Test Account",
            accountNumber: "0000000000",
            bankCode: "250655",
            amount: 0.01,
            reference: "TEST-001",
            description: "Integration test",
          })
          return NextResponse.json(result)
        }
        case "transunion": {
          const idNumber = body.idNumber ?? "0000000000000"
          const result = await getCreditReport({
            tenantId: tenant.id,
            idNumber,
            firstName: "Test",
            lastName: "User",
          })
          return NextResponse.json(result)
        }
        case "smileidentity": {
          const idNumber = body.idNumber ?? "0000000000000"
          const result = await verifyId({
            idNumber,
            firstName: "Test",
            lastName: "User",
            dateOfBirth: "1990-01-01",
          })
          return NextResponse.json(result)
        }
        case "collections": {
          const config = await prisma.tenantConfig.findUnique({ where: { tenantId: tenant.id } })
          const provider = getAvsProvider({
            collectionProvider: config?.collectionProvider ?? null,
            avsProvider: config?.avsProvider ?? null,
          })
          const result = await provider.verifyAccount(
            { accountHolder: "Test Account", idNumber: "0000000000000", bankName: "FNB",
              branchCode: "250655", accountNumber: "0000000000", accountType: "CHEQUE" },
            { netcashRiskReportsKey: config?.netcashRiskReportsKey, netcashDebitOrderKey: config?.netcashDebitOrderKey }
          )
          // `simulated` must survive this hand-rebuild. The AVS adapter labels a
          // dry-run pass, but this response is reconstructed field-by-field, so
          // dropping it here would put an UNLABELLED success in front of
          // integrationTestResultMessage() — which then renders the green
          // "Connection successful" this change exists to prevent.
          return NextResponse.json({
            ok: true,
            provider: provider.id,
            passed: result.passed,
            checks: result.checks,
            ...(result.simulated ? { simulated: true as const } : {}),
          })
        }
        default:
          return NextResponse.json({ error: "Unknown provider" }, { status: 400 })
      }
    } catch (e) {
      console.error(`Integration test failed for ${provider}:`, e)
      return NextResponse.json(
        { ok: false, error: e instanceof Error ? e.message : "Test failed" },
        { status: 500 }
      )
    }
  })
}
