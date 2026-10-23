import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }))

import { canDo } from "@/lib/auth-guards"
import { ROLE_HIERARCHY } from "@/lib/permissions"
import type { AppRole } from "@/lib/auth-config"
import type { PermissionKey } from "@/lib/auth-guards"

// The database repeats two permissions' role lists (docs/asset-finance/SLICE5-FOLLOWUPS.md part T): who may ask for
// and decide a meter-reading void (manage_asset_finance), and who may record, confirm and end a theft report
// (view_asset_position). A role added to either permission must reach the SQL too, and the other way round.
const MIGRATION = readFileSync(path.join(__dirname, "../../prisma/migrations/20261022110100_telematics_followups/migration.sql"), "utf8")
/** Every `u."role"::text IN (…)` list in the migration, sorted. */
const lists = [...MIGRATION.matchAll(/u\."role"::text IN \(([^)]*)\)/g)].map((m) => m[1].split(",").map((r) => r.trim().replace(/'/g, "")).sort())
const rolesWith = (permission: PermissionKey) => ROLE_HIERARCHY.filter((r) => canDo(r as AppRole, permission)).sort()

describe("SQL role lists match the permission registry", () => {
  it("meter-reading voids (request and decision): manage_asset_finance; theft reports (record, confirm, end): view_asset_position", () => {
    const view = lists.filter((l) => l.includes("COLLECTIONS_AGENT"))
    const manage = lists.filter((l) => !l.includes("COLLECTIONS_AGENT"))
    expect([manage.length, view.length]).toEqual([2, 3])
    for (const list of manage) expect(list).toEqual(rolesWith("manage_asset_finance"))
    for (const list of view) expect(list).toEqual(rolesWith("view_asset_position"))
  })
})
