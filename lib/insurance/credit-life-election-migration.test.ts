import { describe, expect, it } from "vitest"
import { baselineConstraintSql, readBaselineSql } from "../db-baseline.test-helpers"

const baseline = readBaselineSql()
const loanApplicationTable = baseline.match(/^CREATE TABLE "LoanApplication" \([\s\S]*?^\);/m)?.[0] ?? ""
const electionComplete = baselineConstraintSql("LoanApplication_credit_life_election_complete")

describe("credit-life election evidence schema", () => {
  it("declares the enum, fields, and completeness constraint", () => {
    expect(baseline).toContain(
      `CREATE TYPE "CreditLifeElection" AS ENUM ('ACCEPTED', 'DECLINED')`,
    )
    expect(loanApplicationTable).not.toBe("")
    for (const column of [
      "creditLifeElection",
      "creditLifeProductId",
      "creditLifeProductName",
      "creditLifeInsurerId",
      "creditLifeInsurerName",
      "creditLifeMonthlyPremiumCents",
      "creditLifeDisclosureVersion",
      "creditLifeDisclosureSha256",
      "creditLifeDisclosureAcknowledgedAt",
      "creditLifeDisclosureAcknowledgedBy",
    ]) {
      expect(loanApplicationTable).toContain(`"${column}" `)
    }
    expect(electionComplete).toMatch(
      /^ALTER TABLE "LoanApplication" ADD CONSTRAINT "LoanApplication_credit_life_election_complete" CHECK /,
    )
  })

  it("admits a wholly null election instead of requiring a synthesised one", () => {
    expect(electionComplete).toMatch(
      /\("creditLifeElection" IS NULL\)[\s\S]*\("creditLifeDisclosureAcknowledgedBy" IS NULL\)/,
    )
  })

  it("requires every evidence field explicitly because a PostgreSQL CHECK accepts NULL", () => {
    for (const column of [
      "creditLifeProductId",
      "creditLifeProductName",
      "creditLifeInsurerId",
      "creditLifeInsurerName",
      "creditLifeMonthlyPremiumCents",
      "creditLifeDisclosureVersion",
      "creditLifeDisclosureSha256",
      "creditLifeDisclosureAcknowledgedAt",
      "creditLifeDisclosureAcknowledgedBy",
    ]) {
      expect(electionComplete).toContain(`("${column}" IS NOT NULL)`)
    }
    expect(electionComplete).toContain(
      `("creditLifeDisclosureVersion" = 'credit-life-election-v1'::text)`,
    )
    expect(electionComplete).toContain(
      `("creditLifeDisclosureSha256" ~ '^[0-9a-f]{64}$'::text)`,
    )
    expect(electionComplete).toContain('("creditLifeMonthlyPremiumCents" > 0)')
  })
})
