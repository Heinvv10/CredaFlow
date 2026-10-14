import fs from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

const migration = (name: string) => fs.readFileSync(
  path.join(process.cwd(), "prisma", "migrations", name, "migration.sql"),
  "utf8",
)

describe("entity NCA migration source transforms", () => {
  it("extends approval without replacing the consumer PASQ predicate", () => {
    const sql = migration("20261013133000_asset_finance_nca_entity")
    expect(sql).toContain("SELECT pg_get_constraintdef(oid) INTO definition")
    expect(sql).toContain(`\"entityId\" IS NOT NULL AND \"ncaRegime\" = ''NCA''`)
    expect(sql).toContain('CREATE TRIGGER "LoanApplication_asset_entity_nca_guard"')
  })

  it("adapts the PASQ ledger identity and credit-life containment branches", () => {
    const sql = migration("20261013133100_asset_finance_nca_entity_ledger")
    expect(sql).toContain('COALESCE(booked."clientId", booked."ncaRepresentativeClientId")')
    expect(sql).toContain("Entity NCA loan requires its matched entity, declined credit life and no bundled policy")
    expect(sql).toContain('CREATE TRIGGER "LoanApplication_asset_entity_nca_disbursed_loan"')
  })
})
