import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { Prisma } from "@prisma/client"
import { baselineIndexSql } from "../db-baseline.test-helpers"
import {
  isUniqueConstraintViolation,
  OPEN_APPLICATION_STATUSES,
} from "./open-application"

/** Every file that reads open applications, found by what it imports, so a new one is held to this too. */
function openApplicationReads(): Array<{ file: string; line: number; text: string }> {
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    return entry.isDirectory() ? walk(path) : /\.tsx?$/.test(entry.name) && !/\.test\.|fixture/.test(entry.name) ? [path] : []
  })
  return ["app", "lib"].flatMap(walk).flatMap((file) => {
    const lines = readFileSync(file, "utf8").split("\n")
    return lines.flatMap((text, i) => (text.includes("in: [...OPEN_APPLICATION_STATUSES]") ? [{ file, line: i + 1, text: lines.slice(i, i + 3).join("\n") }] : []))
  })
}

describe("open application invariant", () => {
  it("no read of a client's open applications counts a loan change's: the unique index leaves it out, and the borrower did not make it", () => {
    const reads = openApplicationReads()
    expect(reads.length).toBeGreaterThanOrEqual(10)
    expect(reads.filter((read) => !read.text.includes("loanChangeRequestId: null")).map((read) => `${read.file}:${read.line}`)).toEqual([])
  })

  it("keeps the application states covered by the database invariant explicit", () => {
    expect(OPEN_APPLICATION_STATUSES).toEqual([
      "DRAFT",
      "SUBMITTED",
      "UNDER_REVIEW",
      "APPROVED",
    ])
  })

  it("keeps the partial unique index aligned with the shared open-state list", () => {
    const migration = baselineIndexSql("LoanApplication_one_open_per_client_product_idx")
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "LoanApplication_one_open_per_client_product_idx"',
    )
    for (const status of OPEN_APPLICATION_STATUSES) {
      expect(migration).toContain(`'${status}'::"AppStatus"`)
    }
    expect(migration).not.toContain("'DECLINED'")
    expect(migration).not.toContain("'DISBURSED'")
    expect(migration).not.toContain("'CANCELLED'")
  })

  it("recognises Prisma unique violations without swallowing other database errors", () => {
    expect(isUniqueConstraintViolation(new Prisma.PrismaClientKnownRequestError(
      "Unique constraint failed",
      { code: "P2002", clientVersion: "5.x" },
    ))).toBe(true)
    expect(isUniqueConstraintViolation(new Prisma.PrismaClientKnownRequestError(
      "Transaction conflict",
      { code: "P2034", clientVersion: "5.x" },
    ))).toBe(false)
    expect(isUniqueConstraintViolation(new Error("P2002"))).toBe(false)
  })
})
