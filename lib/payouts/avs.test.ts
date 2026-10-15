import { afterEach, describe, expect, it, vi } from "vitest"
import { assertPayoutAvs, PayoutAvsError } from "./avs"

vi.mock("@/lib/compliance/avs-subject", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/compliance/avs-subject")>()),
  avsCheckMatchesSubject: () => true,
}))

const client = {
  id: "client-1", idNumber: "9001016000082", firstName: "A", lastName: "B", dateOfBirth: new Date("1990-01-01T00:00:00Z"),
}
const account = { bankName: "FNB", bankAccountNumber: "12345", bankBranchCode: "250655", accountType: "SAVINGS" }
const live = { id: "avs-1", clientId: "client-1", applicationId: "app-1", subjectFingerprint: "f", passed: true, provider: "netcash", raw: { accountActive: true } }
const args = { tenantId: "t-1", applicationId: "app-1", client, account }

function reader(row: Record<string, unknown> | null) {
  return { avsCheck: { findFirst: vi.fn(async () => row) } } as never
}

afterEach(() => vi.unstubAllEnvs())

describe("assertPayoutAvs", () => {
  it("accepts a passing, application-bound AVS for the payout account", async () => {
    await expect(assertPayoutAvs(reader(live), args)).resolves.toEqual({ avsCheckId: "avs-1", simulated: false })
  })

  it("refuses no AVS, a failed AVS, or one bound to another application", async () => {
    await expect(assertPayoutAvs(reader(null), args)).rejects.toBeInstanceOf(PayoutAvsError)
    await expect(assertPayoutAvs(reader({ ...live, passed: false }), args)).rejects.toThrow(/failed/)
    await expect(assertPayoutAvs(reader({ ...live, applicationId: "other" }), args)).rejects.toThrow(/application-bound/)
  })

  it("refuses a simulated AVS pass on a deployed build unless that simulation is declared", async () => {
    const simulated = { ...live, raw: "dry-run" }
    await expect(assertPayoutAvs(reader(simulated), args)).resolves.toEqual({ avsCheckId: "avs-1", simulated: true })
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("SIMULATED_INTEGRATIONS", "")
    await expect(assertPayoutAvs(reader(simulated), args)).rejects.toThrow(/simulated/)
    await expect(assertPayoutAvs(reader({ ...simulated, provider: "someone-else" }), args)).rejects.toThrow(/simulated/)
    vi.stubEnv("SIMULATED_INTEGRATIONS", "netcash-collections")
    await expect(assertPayoutAvs(reader(simulated), args)).resolves.toMatchObject({ simulated: true })
  })
})
