/**
 * Real-PostgreSQL proof of STAFF_TOTP_OFF_SQL (scripts/demo/lib.sh), which
 * restore.sh runs on a staged demo db: staff lose TOTP, SUPER_ADMIN keeps it.
 * The statement updates every user, so it runs in a transaction that is rolled
 * back. Run only against a throwaway, fully migrated database:
 *
 *   RUN_DEMO_TOTP_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run scripts/demo/staff-totp-off.integration.test.ts
 */
import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { prisma } from "@/lib/prisma"
import { withoutTenantScope } from "@/lib/tenant-scope"

const RUN = process.env.RUN_DEMO_TOTP_IT === "1"
const suite = RUN ? describe : describe.skip
const token = randomUUID().replaceAll("-", "")
const tenantId = `tenant_demo_totp_${token}`
const adminId = `user_demo_totp_admin_${token}`
const superId = `user_demo_totp_super_${token}`

class Rollback extends Error {}

function staffTotpOffSql(): string {
  const lib = join(__dirname, "lib.sh")
  const r = spawnSync("bash", ["-c", '. "$0"; printf %s "$STAFF_TOTP_OFF_SQL"', lib], { encoding: "utf8" })
  if (r.status !== 0) throw new Error(`lib.sh: ${r.stderr}`)
  return r.stdout
}

suite("demo restore: STAFF_TOTP_OFF_SQL", () => {
  beforeAll(async () => {
    await withoutTenantScope(async () => {
      await prisma.tenant.create({ data: { id: tenantId, slug: `demo-totp-${token}`, name: "Demo TOTP integration" } })
      for (const [id, role] of [[adminId, "ADMIN"], [superId, "SUPER_ADMIN"]] as const) {
        await prisma.user.create({
          data: {
            id, tenantId, role,
            email: `${role.toLowerCase()}-${token}@example.test`,
            password: "synthetic-test-only",
            totpEnabled: true,
            totpSecret: "JBSWY3DPEHPK3PXP",
            lastTotpCounter: 1,
          },
        })
      }
    })
  })

  afterAll(async () => {
    await withoutTenantScope(async () => {
      await prisma.user.deleteMany({ where: { id: { in: [adminId, superId] } } })
      await prisma.tenant.delete({ where: { id: tenantId } })
    })
  })

  it("clears TOTP for staff, keeps it for SUPER_ADMIN, and reports the count", async () => {
    const sql = staffTotpOffSql()
    let seen: { id: string; totpEnabled: boolean; totpSecret: string | null; lastTotpCounter: number | null }[] = []
    let count = 0n
    await expect(
      withoutTenantScope(() =>
        prisma.$transaction(async (tx) => {
          const rows = await tx.$queryRawUnsafe<{ count: bigint }[]>(sql)
          count = rows[0].count
          seen = await tx.user.findMany({
            where: { id: { in: [adminId, superId] } },
            select: { id: true, totpEnabled: true, totpSecret: true, lastTotpCounter: true },
          })
          throw new Rollback()
        }),
      ),
    ).rejects.toBeInstanceOf(Rollback)

    expect(count).toBeGreaterThanOrEqual(1n)
    expect(seen.find((u) => u.id === adminId)).toMatchObject({ totpEnabled: false, totpSecret: null, lastTotpCounter: null })
    expect(seen.find((u) => u.id === superId)).toMatchObject({ totpEnabled: true, totpSecret: "JBSWY3DPEHPK3PXP", lastTotpCounter: 1 })
  })
})
