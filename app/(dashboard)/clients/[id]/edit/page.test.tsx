import { beforeEach, describe, expect, it, vi } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"

const mocks = vi.hoisted(() => ({
  clientFindUnique: vi.fn(),
  clientForm: vi.fn(),
}))

vi.mock("@/lib/prisma", () => ({
  prisma: { client: { findUnique: mocks.clientFindUnique } },
}))
vi.mock("@/lib/session-tenant", () => ({
  getStaffTenantId: vi.fn().mockResolvedValue("tenant-1"),
}))
vi.mock("@/lib/auth", () => ({
  auth: vi.fn().mockResolvedValue({ user: { role: "SUPER_ADMIN" } }),
}))
vi.mock("@/lib/clients/referral-update", () => ({
  canReassignReferralAgent: vi.fn().mockReturnValue(true),
}))
vi.mock("@/components/layout/Header", () => ({ Header: () => null }))
vi.mock("@/components/clients/ClientFormLegacy", () => ({
  ClientForm: (props: unknown) => {
    mocks.clientForm(props)
    return <div>Client form</div>
  },
}))

import EditClientPage from "./page"

const baseClient = {
  id: "client-1",
  updatedAt: new Date("2026-07-29T10:00:00Z"),
  firstName: "Test",
  lastName: "Client",
  idNumber: "9001015000085",
  dateOfBirth: new Date("1990-01-01T00:00:00Z"),
  gender: "MALE",
  email: "client@example.test",
  phone: "0820000000",
  whatsapp: null,
  addressLine1: null,
  suburb: null,
  city: null,
  province: null,
  postalCode: null,
  employmentStatus: "EMPLOYED",
  employerName: null,
  employerAddress: null,
  employmentStartDate: null,
  salaryPaymentDay: null,
  grossMonthlyIncome: null,
  monthlyIncome: 1_800_000,
  monthlyExpenses: 900_000,
  incomeSourceType: null,
  bankName: null,
  bankAccountNumber: null,
  bankBranchCode: null,
  accountType: null,
  nextOfKinName: null,
  nextOfKinPhone: null,
  nextOfKinRelationship: null,
  popiaConsentGiven: true,
  referralCodeId: null,
  referralCode: null,
}

function capturedInitialData() {
  const props = mocks.clientForm.mock.calls.at(-1)?.[0] as {
    initialData: {
      expenseBreakdown?: Record<string, number | string>
      debtObligations: Array<{
        outstandingBalance: number
        monthlyInstalment: number
      }>
    }
  }
  return props.initialData
}

describe("EditClientPage money-unit boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("passes stored expense and debt amounts to ClientForm in raw cents", async () => {
    mocks.clientFindUnique.mockResolvedValue({
      ...baseClient,
      expenseBreakdown: {
        housing: 300_000,
        transport: 150_000,
        food: 200_000,
        education: 0,
        insurance: 50_000,
        clothing: 0,
        entertainment: 0,
        medical: 0,
        other: 200_000,
        belowMleJustification: "Existing audited reason",
      },
      debtObligations: [{
        id: "debt-1",
        creditProvider: "Bank",
        accountType: "Personal loan",
        outstandingBalance: 250_000,
        monthlyInstalment: 49_100,
        notes: null,
      }],
    })

    renderToStaticMarkup(await EditClientPage({
      params: Promise.resolve({ id: "client-1" }),
    }))

    expect(capturedInitialData().expenseBreakdown).toMatchObject({
      housing: 300_000,
      other: 200_000,
      belowMleJustification: "Existing audited reason",
    })
    expect(capturedInitialData().debtObligations[0]).toMatchObject({
      outstandingBalance: 250_000,
      monthlyInstalment: 49_100,
    })
  })

  it("seeds a legacy cached expense total into other in raw cents", async () => {
    mocks.clientFindUnique.mockResolvedValue({
      ...baseClient,
      expenseBreakdown: null,
      debtObligations: [],
    })

    renderToStaticMarkup(await EditClientPage({
      params: Promise.resolve({ id: "client-1" }),
    }))

    expect(capturedInitialData().expenseBreakdown).toMatchObject({
      housing: 0,
      other: 900_000,
    })
  })
})
