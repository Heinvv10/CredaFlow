/**
 * Shared harness for the recovery break-testing repros (RUN_ASSET_FINANCE_RECOVERY_IT).
 * Not a test file.
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { vi } from "vitest"
import type { SessionUser } from "./payout-booking.integration-fixture"
import { createRecoveryFixture, type RecoveryFixture } from "./recovery.integration-fixture"
import { recoveryRoutes } from "./recovery-routes.integration-fixture"
import { readJson, saleRoutes } from "./recovery-sale.integration-fixture"
import { legalRoutes } from "./legal-matter.integration-fixture"
import { e2eRoutes } from "./recovery-e2e.integration-fixture"

export const RUN = process.env.RUN_ASSET_FINANCE_RECOVERY_IT === "1"
export const db = RUN ? new PrismaClient() : (null as unknown as PrismaClient)
export const token = () => randomUUID().replaceAll("-", "").slice(0, 16)

export const sessionBox = { current: null as null | { user: SessionUser } }
export type Role = "CREDIT_OFFICER" | "LOAN_ADMIN"
export const asUser = (fx: RecoveryFixture, id: string, role: Role) => { sessionBox.current = { user: { id, email: `${id}@break-it.test`, role, tenantId: fx.tenantId } } }

export async function makeTenant(): Promise<RecoveryFixture> {
  const fx = await createRecoveryFixture(db, token())
  await db.vatConfig.create({ data: { tenantId: fx.tenantId, vatNumber: "4000000001", registeredName: "TEST Asset Credit (Pty) Ltd", address: "1 Synthetic Road, Johannesburg, 2000" } })
  await db.tenantConfig.update({ where: { tenantId: fx.tenantId }, data: { bureauReportingStartDate: new Date("2020-01-01T00:00:00Z") } })
  return fx
}

export const bundle = (fx: RecoveryFixture) => ({ r: recoveryRoutes(fx.host), s: saleRoutes(fx.host), l: legalRoutes(fx.host), e: e2eRoutes(fx.host) })
export { readJson, vi }
