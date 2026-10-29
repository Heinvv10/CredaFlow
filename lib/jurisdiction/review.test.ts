// Ported from the PR #253 round-1 breaker repros, adapted to the enforced design:
// one jurisdiction per instance (a single InstanceJurisdiction row), ZA never billed in
// loti, and no "NCR null" on paper or in public copy.
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/prisma", () => ({ prisma: {} }))

import { activeJurisdiction, isNcaJurisdiction, resetActiveJurisdiction, setActiveJurisdiction } from "@/lib/jurisdiction/active"
import { JurisdictionChangedError, loadActiveJurisdiction } from "@/lib/jurisdiction/load.server"
import { evaluateCollectionsEligibility } from "@/lib/collections/section129-eligibility"
import { formatZarPdf } from "@/lib/pdf/helpers"
import { formatZAR } from "@/lib/utils"
import { buildKnowledge } from "@/lib/website-chat/knowledge"
import { lenderLetterhead } from "@/lib/asset-finance/documents/document-parts"
import { LenderIdentityError } from "@/lib/config/identity-schema"

afterEach(() => { resetActiveJurisdiction(); delete process.env.NEXT_PUBLIC_TENANT_SLUG })

const zaLoan = { status: "ACTIVE", ncaRegime: "NCA" as const, arrearsAmount: 500_00, outstandingPrincipal: 10_000_00, daysInArrears: 120 }
const instance = (jurisdiction: string, currency: string) => ({ instanceJurisdiction: { findUnique: vi.fn(async () => ({ id: 1, jurisdiction, currency })) } })
vi.spyOn(console, "error").mockImplementation(() => {})

describe("a warm process never serves under a stale jurisdiction (breaker repro A)", () => {
  it("an LS process whose database now says ZA refuses to load it, rather than let a ZA loan lose Section 129 or print Maloti", async () => {
    await loadActiveJurisdiction(instance("LS", "LSL") as never)
    expect(evaluateCollectionsEligibility(zaLoan, "SECTION_129").eligible).toBe(false) // correct for an LS instance
    await expect(loadActiveJurisdiction(instance("ZA", "ZAR") as never)).rejects.toBeInstanceOf(JurisdictionChangedError)
  })

  it("reads the instance row and nothing else (no tenant, no slug)", async () => {
    process.env.NEXT_PUBLIC_TENANT_SLUG = "ignored"
    const db = instance("ZA", "ZAR")
    await loadActiveJurisdiction(db as never)
    expect(db.instanceJurisdiction.findUnique).toHaveBeenCalledWith({ where: { id: 1 } })
    expect(evaluateCollectionsEligibility(zaLoan, "SECTION_129").eligible).toBe(true)
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
