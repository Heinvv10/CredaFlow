// Ported from the PR #253 round-1 breaker repros, adapted to the enforced design:
// one jurisdiction per instance (refused at boot otherwise), ZA never billed in
// loti, and no "NCR null" on paper or in public copy.
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/prisma", () => ({ prisma: {} }))

import { activeJurisdiction, isNcaJurisdiction, resetActiveJurisdiction, setActiveJurisdiction } from "@/lib/jurisdiction/active"
import { JurisdictionConflictError, loadActiveJurisdiction } from "@/lib/jurisdiction/load.server"
import { evaluateCollectionsEligibility } from "@/lib/collections/section129-eligibility"
import { formatZarPdf } from "@/lib/pdf/helpers"
import { formatZAR } from "@/lib/utils"
import { buildKnowledge } from "@/lib/website-chat/knowledge"
import { lenderLetterhead } from "@/lib/asset-finance/documents/document-parts"
import { LenderIdentityError } from "@/lib/config/identity-schema"

afterEach(() => { resetActiveJurisdiction(); delete process.env.NEXT_PUBLIC_TENANT_SLUG })

const zaLoan = { status: "ACTIVE", ncaRegime: "NCA" as const, arrearsAmount: 500_00, outstandingPrincipal: 10_000_00, daysInArrears: 120 }
const row = (slug: string, jurisdiction: string, currency: string) => ({ tenant: { slug }, jurisdiction, currency })
vi.spyOn(console, "error").mockImplementation(() => {})

describe("a ZA tenant can never be served under an LS gate", () => {
  it("an instance mixing an LS and a ZA tenant is refused, so a ZA loan cannot lose Section 129", async () => {
    process.env.NEXT_PUBLIC_TENANT_SLUG = "basotho"
    const db = { tenantConfig: { findMany: vi.fn(async () => [row("basotho", "LS", "LSL"), row("acme", "ZA", "ZAR")]) } }
    await expect(loadActiveJurisdiction(db as never)).rejects.toBeInstanceOf(JurisdictionConflictError)
    expect(evaluateCollectionsEligibility(zaLoan, "SECTION_129").eligible).toBe(true)
  })

  it("the loader reads only ACTIVE tenants", async () => {
    const findMany = vi.fn(async (_args: { where: unknown }) => [row("x", "ZA", "ZAR")])
    await loadActiveJurisdiction({ tenantConfig: { findMany } } as never)
    expect(findMany.mock.calls[0][0].where).toEqual({ tenant: { status: "ACTIVE" } })
  })
})

describe("ZA is never billed in loti", () => {
  it("refuses ZA + LSL, so NCA documents cannot print Maloti", () => {
    expect(() => setActiveJurisdiction({ jurisdiction: "ZA", currency: "LSL" })).toThrow()
    expect(isNcaJurisdiction()).toBe(true)
    expect(activeJurisdiction()).toBe("ZA")
    expect(formatZarPdf(123456)).toBe("R 1,234.56")
    expect(formatZAR(123456)).toBe("R 1,234.56")
  })
})

const lsIdentity = {
  legalName: "Demo Basotho Lending (Pty) Ltd", tradingName: "Demo Basotho Lending", ncrNumber: null, fspNumber: null,
  companyRegNumber: "2099/000001", registeredOfficeLines: ["1 Demo Road", "Maseru"], publicPhone: "+266 2200 0000",
  publicWhatsapp: null, publicEmail: "a@b.example", headOfficeCity: "Maseru", ncrStatus: null, ncrRegistrationDate: null,
  fscaAuthorisationDate: null,
} as never

describe("an LS lender with no NCR number never prints 'NCR null'", () => {
  it("website AI-chat knowledge", () => {
    setActiveJurisdiction({ jurisdiction: "LS", currency: "LSL" })
    const k = buildKnowledge({ identity: lsIdentity, products: [], insurance: [] })
    expect(k).not.toMatch(/NCR registration null|null/)
  })

  it("the asset-finance letterhead refuses rather than print it", () => {
    const lines: string[][] = []
    const writer = { letterhead: (_n: string, l: string[]) => lines.push(l) } as never
    expect(() => lenderLetterhead(writer, { lender: lsIdentity })).toThrow(LenderIdentityError)
    expect(lines).toEqual([])
  })
})
