import { beforeEach, describe, expect, it, vi } from "vitest"

// Server actions that already guard themselves on main. The CRM actions that
// checked only for a session (generateCrossSellOpportunities, updateLeadStatus,
// addLeadActivity, toggleLeadActivityPinned) are tested once their guard lands.
//
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

import { reassignLead, resetStrandedConvertedLead } from "./crm"
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
  ["reassignLead", () => reassignLead("lead-1", "u2")],
  ["resetStrandedConvertedLead", () => resetStrandedConvertedLead("lead-1")],
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
