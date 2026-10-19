// Backfill a demo lender's asset-finance templates after upgrading a stack
// past the lender-owned templates migration (20261018140100): without them no
// deal document can be prepared. Adopts every family's starter, approves it
// as one staff user and publishes it as another, with the SYNTHETIC_DEMO
// basis (documents keep the demo watermark). Refuses a lender that is not
// TenantConfig.isDemoLender: it never records a legal approval. Idempotent.
// Also run it after an upgrade that changes CredaFlow's protected wording
// (SYSTEM_REVISION): it approves the lapsed variants again.
//
// The two users are different active LOAN_ADMIN-or-above staff of the lender
// (the database refuses anyone else). On a stack restored from a snapshot,
// re-snapshot afterwards or the next restore removes the templates again.
//
//   DATABASE_URL=... npx tsx scripts/asset-finance/ensure-demo-templates.ts <tenant-slug> <author-email> <approver-email>
//   (needs lib/registry/generated: run `npm run gen:registries` first)
import { prisma } from "@/lib/prisma"
import { runWithTenant } from "@/lib/tenant-scope"
import { ensureSyntheticTemplates } from "@/prisma/seed/asset-finance-templates"

async function main(): Promise<void> {
  const [slug, authorEmail, approverEmail] = process.argv.slice(2)
  if (!slug || !authorEmail || !approverEmail || authorEmail === approverEmail) {
    throw new Error("usage: ensure-demo-templates.ts <tenant-slug> <author-email> <approver-email> (two different staff users)")
  }
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug }, select: { id: true } })
  const staff = async (email: string) => {
    const user = await prisma.user.findFirstOrThrow({ where: { tenantId: tenant.id, email: email.toLowerCase(), active: true }, select: { id: true, email: true } })
    return { id: user.id, email: user.email }
  }
  const [adminOne, adminTwo] = [await staff(authorEmail), await staff(approverEmail)]
  await runWithTenant(tenant.id, () => ensureSyntheticTemplates(tenant.id, { adminOne, adminTwo }))
  const published = await prisma.documentTemplate.count({ where: { tenantId: tenant.id, kind: "ASSET_FINANCE", currentVersionId: { not: null } } })
  process.stdout.write(`${slug}: ${published} asset-finance templates published (synthetic demo approval)\n`)
}

main().then(() => prisma.$disconnect(), async (error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  await prisma.$disconnect()
  process.exit(1)
})
