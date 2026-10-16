import { describe, expect, it } from "vitest"
import { getCreditReport } from "./experian"
import { ENQUIRY_PURPOSE } from "./experian-spec"

const enquiry = (identityNumber: string) => getCreditReport({
  identityNumber,
  identityType: "SID",
  surname: "Dube",
  forename: "Ayanda",
  dateOfBirth: `19${identityNumber.slice(0, 2)}-${identityNumber.slice(2, 4)}-${identityNumber.slice(4, 6)}`,
  purpose: ENQUIRY_PURPOSE.AFFORDABILITY_ASSESSMENT,
  clientConsent: "Y",
}, "t1")

// Synthetic SA ID numbers with valid check digits, one per demo-style consumer.
const IDS = ["8001010001089", "8503015002087", "9205010003081", "7812015004089", "9401010005081", "8806015006085",
  "7001010007087", "7102025008084", "7203030009081", "7304045010088", "7405050011083", "9001015012080"]

describe("Experian dry-run report (demo and test stacks)", () => {
  it("is the same report every time for one ID number", async () => {
    expect(await enquiry(IDS[0])).toEqual(await enquiry(IDS[0]))
  })

  it("varies the score and risk grade between consumers, inside the band the demo lender approves", async () => {
    const reports = await Promise.all(IDS.map(enquiry))
    const scores = reports.map((r) => r.score as number)
    expect(new Set(scores).size).toBeGreaterThanOrEqual(6)
    for (const s of scores) {
      // scripts/demo/scenarios/tenant-setup.ts sets the demo lender's floor at 560.
      expect(s).toBeGreaterThanOrEqual(600)
      expect(s).toBeLessThanOrEqual(700)
    }
    expect(new Set(reports.map((r) => r.riskGrade))).toEqual(new Set(["LOW RISK", "AVERAGE RISK"]))
  })

  it("keeps a clean, debt-free record so it never moves an affordability outcome", async () => {
    for (const r of await Promise.all(IDS.map(enquiry))) {
      expect(r).toMatchObject({
        ok: true, simulated: true, unscoreable: false, hasJudgement: false, underDebtReview: false,
        totalMonthlyObligations: 0, accounts: [], obligationRows: [],
      })
    }
  })
})
