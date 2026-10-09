import { describe, it, expect } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"

const schemaPath = join(process.cwd(), "prisma/schema.prisma")
const schema = readFileSync(schemaPath, "utf8")

function extractModel(name: string): string {
  const start = schema.indexOf(`model ${name} {`)
  if (start === -1) return ""
  let depth = 0
  let i = start
  for (; i < schema.length; i++) {
    if (schema[i] === "{") depth++
    if (schema[i] === "}") { depth--; if (depth === 0) break }
  }
  return schema.slice(start, i + 1)
}

const TARGET_MODELS = [
  "Client",
  "Loan",
  "LoanApplication",
  "Payment",
  "RepaymentSchedule",
  "LoanProduct",
  "PaymentArrangement",
  "ClientDocument",
  "LoanNote",
] as const

describe("tenant isolation — schema completeness", () => {
  for (const model of TARGET_MODELS) {
    it(`model ${model} has required tenantId field`, () => {
      const block = extractModel(model)
      expect(block).not.toBe("")
      // Must have tenantId as a required String (no ?)
      expect(block).toMatch(/tenantId\s+String[^?]/)
    })

    it(`model ${model} has Tenant relation`, () => {
      const block = extractModel(model)
      expect(block).toMatch(/tenant\s+Tenant/)
    })

    it(`model ${model} has @@index on tenantId`, () => {
      const block = extractModel(model)
      const hasIndex = block.includes("@@index([tenantId") || block.includes("@@unique([tenantId")
      expect(hasIndex).toBe(true)
    })
  }
})

describe("tenant isolation — lib/tenant.ts exports", () => {
  it("getTenantFromRequest is exported from lib/tenant.ts", async () => {
    const mod = await import("../../lib/tenant")
    expect(typeof mod.getTenantFromRequest).toBe("function")
  })

  it("getDefaultTenantId is exported from lib/tenant.ts", async () => {
    const mod = await import("../../lib/tenant")
    expect(typeof mod.getDefaultTenantId).toBe("function")
  })
})
