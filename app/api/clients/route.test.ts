import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import { Prisma } from "@prisma/client"

const requireApiRoleMock = vi.fn()
const transactionMock = vi.fn()
const clientFindFirstMock = vi.fn()
const identityFindFirstMock = vi.fn()
const logAuditMock = vi.fn()

vi.mock("@/lib/auth-guards", () => ({ requireApiRole: () => requireApiRoleMock() }))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (_req: unknown, cb: (tenant: { id: string }) => Promise<unknown>) => cb({ id: "t1" }),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: (...args: unknown[]) => transactionMock(...args),
    client: { findFirst: (a: unknown) => clientFindFirstMock(a) },
    contactIdentity: { findFirst: (a: unknown) => identityFindFirstMock(a) },
  },
}))
vi.mock("@/lib/audit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/audit")>()),
  logAudit: (...a: unknown[]) => logAuditMock(...a),
}))

import { POST } from "./route"

const VALID_ID = "9307225000082"

/**
 * A wizard payload that clears validateAllClient. The 409 path is what these
 * tests are about, so this only has to be good enough to reach the insert.
 */
const body = () => ({
  firstName: "Themba",
  lastName: "Qatest",
  idNumber: VALID_ID,
  dateOfBirth: "1993-07-22",
  gender: "MALE",
  email: "themba@example.invalid",
  phone: "0721234509",
  whatsapp: "",
  addressLine1: "1 Test Street",
  suburb: "Testville",
  city: "Durban",
  province: "KZN",
  postalCode: "4027",
  employmentStatus: "EMPLOYED",
  employerName: "Synthetic Employer",
  employerAddress: "Cape Town",
  grossMonthlyIncome: "22000",
  monthlyIncome: "20000",
  monthlyExpenses: "8000",
  incomeSourceType: "SALARY",
  employmentStartDate: "2020-01-01",
  salaryPaymentDay: "25",
  bankName: "FNB",
  bankAccountNumber: "62012345678",
  bankBranchCode: "250655",
  accountType: "CHEQUE",
  nextOfKinName: "Nomsa Qatest",
  nextOfKinPhone: "0721234510",
  nextOfKinRelationship: "SPOUSE",
  popiaConsentGiven: true,
  expenseBreakdown: {
    housing: "3000", transport: "1500", food: "2500", education: "0",
    insurance: "500", clothing: "300", medical: "200", entertainment: "0", other: "0",
  },
  debtObligations: [],
})

const request = () =>
  new NextRequest("http://x/api/clients", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body()),
  })

const uniqueViolation = (target: string[], modelName = "Client") =>
  new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "test",
    meta: { modelName, target },
  })

// The exact meta Prisma 5.22 produced against Postgres when a second Contact
// tried to take an existing (tenantId, channel, value) identity.
const identityViolation = () =>
  uniqueViolation(["tenantId", "channel", "value"], "ContactIdentity")

/** Answer contactIdentity.findFirst only for the one (channel, value) held. */
const holdIdentity = (channel: string, value: string, contact: Record<string, unknown>) =>
  identityFindFirstMock.mockImplementation(async (a: { where: { channel: string; value: string } }) =>
    a.where.channel === channel && a.where.value === value ? { contact } : null,
  )

beforeEach(() => {
  vi.clearAllMocks()
  requireApiRoleMock.mockResolvedValue({ user: { id: "officer-1", email: "officer@example.test" } })
  clientFindFirstMock.mockResolvedValue(null)
  identityFindFirstMock.mockResolvedValue(null)
  logAuditMock.mockResolvedValue(undefined)
})

describe("POST /api/clients — duplicate handling", () => {
  it("answers 409 naming the existing client when the ID number is taken", async () => {
    // Before this, P2002 fell through to a catch-all that answered 500
    // "Failed to create client" — the operator was told the server broke, not
    // that this person is already a client.
    transactionMock.mockRejectedValue(uniqueViolation(["idNumber"]))
    clientFindFirstMock.mockResolvedValue({
      id: "c1", reference: "CLI-00042", firstName: "Themba", lastName: "Qatest",
    })

    const res = await POST(request())

    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({
      error: "A client with this ID number already exists",
      field: "idNumber",
      existingClient: { id: "c1", reference: "CLI-00042", firstName: "Themba", lastName: "Qatest" },
    })
  })

  it("looks the existing client up within the caller's tenant only", async () => {
    transactionMock.mockRejectedValue(uniqueViolation(["idNumber"]))

    await POST(request())

    expect(clientFindFirstMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: "t1", idNumber: VALID_ID } })
    )
  })

  it("answers 409 for a duplicate email too", async () => {
    // email carries the same global unique constraint and used to 500 the same
    // way, so the mapping is by field rather than special-cased to idNumber.
    transactionMock.mockRejectedValue(uniqueViolation(["email"]))

    const res = await POST(request())

    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe("A client with this email address already exists")
  })

  it("reports the clash without identity when the holder is another tenant's", async () => {
    transactionMock.mockRejectedValue(uniqueViolation(["idNumber"]))
    clientFindFirstMock.mockResolvedValue(null)   // tenant-scoped lookup finds nobody

    const res = await POST(request())

    expect(res.status).toBe(409)
    expect((await res.json()).existingClient).toBeNull()
  })

  it("still answers 409 naming the holder when Postgres withholds the key (row-level security)", async () => {
    // Under RLS Postgres omits the colliding key, so Prisma's P2002 names no
    // field ("Unique constraint failed on the (not available)").
    transactionMock.mockRejectedValue(uniqueViolation([]))
    clientFindFirstMock.mockImplementation(async (a: { where: Record<string, unknown> }) =>
      "email" in a.where ? { id: "c2", reference: "CLI-00043", firstName: "Sipho", lastName: "Qatest" } : null,
    )

    const res = await POST(request())

    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({
      error: "A client with this email address already exists",
      field: "email",
      existingClient: { id: "c2", reference: "CLI-00043", firstName: "Sipho", lastName: "Qatest" },
    })
    expect(clientFindFirstMock).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: "t1", idNumber: VALID_ID } }))
  })

  it("does not write a CLIENT_CREATED audit row for a refused insert", async () => {
    transactionMock.mockRejectedValue(uniqueViolation(["idNumber"]))

    await POST(request())

    expect(logAuditMock).not.toHaveBeenCalled()
  })
})

describe("POST /api/clients — real failures are not disguised as duplicates", () => {
  it("still answers 500 when the insert fails for any other reason", async () => {
    // A mapping that turned every error into a 409 would report a genuine
    // database fault as a duplicate and hide it from whoever has to fix it.
    transactionMock.mockRejectedValue(new Error("connection terminated"))

    const res = await POST(request())

    expect(res.status).toBe(500)
    expect(clientFindFirstMock).not.toHaveBeenCalled()
  })

  it("still answers 500 for a non-P2002 Prisma error", async () => {
    transactionMock.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Not found", { code: "P2025", clientVersion: "test" })
    )

    const res = await POST(request())

    expect(res.status).toBe(500)
  })
})

describe("POST /api/clients — phone/email already held by another contact", () => {
  // Staff can capture a client whose phone number is already provisioned for
  // a different client. The ContactIdentity unique constraint refuses it with a
  // target of ["tenantId", ...]; a generic "A client with these details already
  // exists" would leave the operator searching for the applicant by ID and name,
  // finding nothing, and stuck.

  it("names the phone number and the client who already has it", async () => {
    transactionMock.mockRejectedValue(identityViolation())
    holdIdentity("SMS", "27721234509", { id: "k1", clientId: "c9", leadId: null })
    clientFindFirstMock.mockResolvedValue({
      id: "c9", reference: "CLI-TEST-0001", firstName: "Lerato", lastName: "Fixture",
    })

    const res = await POST(request())

    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({
      error: "This phone number already belongs to client Lerato Fixture (CLI-TEST-0001)",
      field: "phone",
      existingClient: { id: "c9", reference: "CLI-TEST-0001", firstName: "Lerato", lastName: "Fixture" },
    })
    expect(clientFindFirstMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: "t1", id: "c9" } }),
    )
  })

  it("looks identities up within the caller's tenant only", async () => {
    transactionMock.mockRejectedValue(identityViolation())

    await POST(request())

    expect(identityFindFirstMock).toHaveBeenCalled()
    for (const [arg] of identityFindFirstMock.mock.calls) {
      expect(arg.where.tenantId).toBe("t1")
    }
  })

  it("names the email address when that is what is held", async () => {
    transactionMock.mockRejectedValue(identityViolation())
    holdIdentity("EMAIL", "themba@example.invalid", { id: "k1", clientId: "c9", leadId: null })
    clientFindFirstMock.mockResolvedValue({
      id: "c9", reference: "CLI-00009", firstName: "Sipho", lastName: "Dube",
    })

    const body = await (await POST(request())).json()

    expect(body.field).toBe("email")
    expect(body.error).toBe("This email address already belongs to client Sipho Dube (CLI-00009)")
  })

  it("says a CRM lead holds it when the holder is not a client", async () => {
    transactionMock.mockRejectedValue(identityViolation())
    holdIdentity("SMS", "27721234509", { id: "k1", clientId: null, leadId: "l1" })

    const res = await POST(request())
    const body = await res.json()

    expect(res.status).toBe(409)
    expect(body.error).toBe("This phone number is already linked to a CRM lead")
    expect(body.existingClient).toBeNull()
    expect(clientFindFirstMock).not.toHaveBeenCalled()
  })

  it("falls back to the generic sentence if no holder can be found", async () => {
    transactionMock.mockRejectedValue(identityViolation())

    const res = await POST(request())

    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({
      error: "A client with these details already exists",
      field: null,
      existingClient: null,
    })
  })
})
