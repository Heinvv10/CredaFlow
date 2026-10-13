import { beforeEach, describe, expect, it, vi } from "vitest"

// Every server action is reachable by a POST carrying its action id, so each one
// has to refuse a CLIENT session itself. The real guards run here (auth-guards is
// not mocked): only the session, the redirect and the side effects are stubbed,
// and the side effects must stay untouched for a refused caller.
const { authMock, tenantMock, dbMock, auditMock, applyMock, importMock, lessonMock } = vi.hoisted(() => ({
  authMock: vi.fn(),
  tenantMock: vi.fn(),
  dbMock: vi.fn(),
  auditMock: vi.fn(),
  applyMock: vi.fn(),
  importMock: vi.fn(),
  lessonMock: vi.fn(),
}))

vi.mock("@/lib/auth", () => ({ auth: () => authMock() }))
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`NEXT_REDIRECT:${to}`)
  },
}))
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))
vi.mock("@/lib/tenant", () => ({ getDefaultTenantId: () => tenantMock() }))
vi.mock("@/lib/prisma", () => ({
  prisma: new Proxy({}, { get: () => new Proxy(dbMock, { get: () => dbMock }) }),
}))
vi.mock("@/lib/audit", () => ({ logAudit: auditMock, AuditAction: new Proxy({}, { get: (_t, k) => String(k) }) }))
vi.mock("@/lib/bank-sync/apply", () => ({ applyBankTransaction: applyMock, ignoreBankTransaction: applyMock }))
vi.mock("@/lib/bank-sync/import", () => ({
  importStatement: importMock,
  BankSyncDisabledError: class extends Error {},
  StatementParseError: class extends Error {},
  MAX_STATEMENT_BYTES: 5 * 1024 * 1024,
}))
vi.mock("@/lib/manual/progress", () => ({ setLessonComplete: lessonMock }))
vi.mock("@/lib/crm/staff", () => ({ isAssignableStaff: dbMock }))

import {
  addLeadActivity,
  generateCrossSellOpportunities,
  reassignLead,
  resetStrandedConvertedLead,
  updateLeadStatus,
} from "./crm"
import { toggleLeadActivityPinned } from "./lead-activities"
import { toggleLesson } from "../(dashboard)/learn/actions"
import {
  confirmMatchAction,
  ignoreMatchAction,
  reassignMatchAction,
  uploadStatementAction,
} from "../(dashboard)/payments/bank-reconciliation/actions"

const session = (role: string, tenantId: string | null = "t1") => ({
  user: { id: "u1", email: "someone@example.test", name: "Someone", role, tenantId },
})
const CLIENT = session("CLIENT")

const upload = () => {
  const form = new FormData()
  form.set("file", new File(["a,b\n1,2\n"], "statement.csv", { type: "text/csv" }))
  return form
}

const ACTIONS: Array<[string, () => Promise<unknown>]> = [
  ["generateCrossSellOpportunities", () => generateCrossSellOpportunities()],
  ["updateLeadStatus", () => updateLeadStatus("lead-1", "QUALIFIED")],
  ["addLeadActivity", () => addLeadActivity({ leadId: "lead-1", type: "NOTE", subject: "s" })],
  ["reassignLead", () => reassignLead("lead-1", "u2")],
  ["resetStrandedConvertedLead", () => resetStrandedConvertedLead("lead-1")],
  ["toggleLeadActivityPinned", () => toggleLeadActivityPinned("act-1", true)],
  ["toggleLesson", () => toggleLesson("intro", true)],
  ["confirmMatchAction", () => confirmMatchAction("txn-1", "loan-1")],
  ["reassignMatchAction", () => reassignMatchAction("txn-1", "loan-1")],
  ["ignoreMatchAction", () => ignoreMatchAction("txn-1", "duplicate")],
  ["uploadStatementAction", () => uploadStatementAction(upload())],
]

function expectUntouched() {
  expect(tenantMock).not.toHaveBeenCalled()
  expect(dbMock).not.toHaveBeenCalled()
  expect(auditMock).not.toHaveBeenCalled()
  expect(applyMock).not.toHaveBeenCalled()
  expect(importMock).not.toHaveBeenCalled()
  expect(lessonMock).not.toHaveBeenCalled()
}

beforeEach(() => {
  vi.clearAllMocks()
  tenantMock.mockResolvedValue("t1")
  dbMock.mockRejectedValue(new Error("reached the database"))
})

describe.each(ACTIONS)("%s", (_name, call) => {
  it("refuses a CLIENT session before doing anything", async () => {
    authMock.mockResolvedValue(CLIENT)
    await expect(call()).rejects.toThrow(/NEXT_REDIRECT|Insufficient permissions/)
    expectUntouched()
  })

  it("refuses a caller with no session", async () => {
    authMock.mockResolvedValue(null)
    await expect(call()).rejects.toThrow(/NEXT_REDIRECT|Insufficient permissions|Unauthorized/)
    expectUntouched()
  })
})

// The four actions that checked only for a session now need the CRM write role
// the matching API routes use (app/api/crm/**: CREDIT_OFFICER).
describe.each([
  ["generateCrossSellOpportunities", ACTIONS[0][1]],
  ["updateLeadStatus", ACTIONS[1][1]],
  ["addLeadActivity", ACTIONS[2][1]],
  ["toggleLeadActivityPinned", ACTIONS[5][1]],
])("%s role floor", (_name, call) => {
  it("refuses a READONLY staff session", async () => {
    authMock.mockResolvedValue(session("READONLY"))
    await expect(call()).rejects.toThrow(/NEXT_REDIRECT/)
    expectUntouched()
  })

  it("refuses a staff session whose tenant binding is gone", async () => {
    authMock.mockResolvedValue(session("CREDIT_OFFICER", null))
    await expect(call()).rejects.toThrow(/NEXT_REDIRECT/)
    expectUntouched()
  })

  it("lets a CREDIT_OFFICER through the guard", async () => {
    authMock.mockResolvedValue(session("CREDIT_OFFICER"))
    await expect(call()).rejects.toThrow("reached the database")
    expect(tenantMock).toHaveBeenCalled()
  })
})
