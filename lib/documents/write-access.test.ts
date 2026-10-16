import { beforeEach, describe, expect, it, vi } from "vitest"
import type { UserRole } from "@prisma/client"

const logAuditMock = vi.fn()
const authMock = vi.fn()

vi.mock("@/lib/audit", () => ({
  logAudit: (...args: unknown[]) => logAuditMock(...args),
  AuditAction: { DOCUMENT_ACCESS_REFUSED: "DOCUMENT_ACCESS_REFUSED" },
}))
vi.mock("@/lib/auth", () => ({ auth: () => authMock() }))

import {
  canWriteDocuments,
  isDocumentReadOnlyRole,
  READ_ONLY_DOCUMENT_ERROR,
  refuseReadOnlyDocumentWrite,
} from "./write-access"
import type { CallerInfo } from "@/lib/document-auth"

const WRITING_STAFF_ROLES: UserRole[] = [
  "SUPER_ADMIN",
  "ADMIN",
  "LOAN_ADMIN",
  "CREDIT_OFFICER",
  "COLLECTIONS_OFFICER",
  "COLLECTIONS_AGENT",
  "INSURANCE_OFFICER",
  "BRANCH_MANAGER",
]

function staff(role: UserRole): CallerInfo {
  return { type: "staff", userId: `user-${role}`, role, tenantId: "tenant-1" }
}

const client: CallerInfo = { type: "client", clientId: "client-1", email: "client@example.test" }

function req() {
  return new Request("http://acme.localhost/api/documents", {
    method: "POST",
    headers: { "user-agent": "vitest" },
  })
}

beforeEach(() => {
  logAuditMock.mockReset()
  authMock.mockReset()
  authMock.mockResolvedValue({ user: { email: "readonly@example.test" } })
})

describe("isDocumentReadOnlyRole", () => {
  it("is true for READONLY only", () => {
    expect(isDocumentReadOnlyRole("READONLY")).toBe(true)
    for (const role of WRITING_STAFF_ROLES) expect(isDocumentReadOnlyRole(role)).toBe(false)
  })

  it("is false for a missing role", () => {
    expect(isDocumentReadOnlyRole(null)).toBe(false)
    expect(isDocumentReadOnlyRole(undefined)).toBe(false)
  })
})

describe("canWriteDocuments", () => {
  it("refuses a READONLY staff caller", () => {
    expect(canWriteDocuments(staff("READONLY"))).toBe(false)
  })

  it.each(WRITING_STAFF_ROLES)("allows %s, as before", (role) => {
    expect(canWriteDocuments(staff(role))).toBe(true)
  })

  it("leaves a portal client unaffected", () => {
    expect(canWriteDocuments(client)).toBe(true)
  })
})

describe("refuseReadOnlyDocumentWrite", () => {
  it("answers 403 with the plain error for READONLY and audits the refusal", async () => {
    const res = await refuseReadOnlyDocumentWrite({
      caller: staff("READONLY"),
      documentId: "doc-1",
      tenantId: "tenant-1",
      action: "sign",
      req: req(),
    })

    expect(res?.status).toBe(403)
    expect(await res?.json()).toEqual({ error: READ_ONLY_DOCUMENT_ERROR })
    expect(logAuditMock).toHaveBeenCalledTimes(1)
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({
      action: "DOCUMENT_ACCESS_REFUSED",
      entity: "ClientDocument",
      entityId: "doc-1",
      tenantId: "tenant-1",
      userId: "user-READONLY",
      userEmail: "readonly@example.test",
      newValue: expect.objectContaining({
        refused: true,
        reason: "document_write_read_only_role",
        httpStatus: 403,
        action: "sign",
        role: "READONLY",
      }),
    }))
  })

  it("still refuses when the audit write throws", async () => {
    logAuditMock.mockRejectedValueOnce(new Error("audit down"))
    const res = await refuseReadOnlyDocumentWrite({
      caller: staff("READONLY"),
      documentId: "upload",
      tenantId: "tenant-1",
      action: "upload",
      req: req(),
    })
    expect(res?.status).toBe(403)
  })

  it.each(WRITING_STAFF_ROLES)("returns null and audits nothing for %s", async (role) => {
    const res = await refuseReadOnlyDocumentWrite({
      caller: staff(role),
      documentId: "doc-1",
      tenantId: "tenant-1",
      action: "extract",
      req: req(),
    })
    expect(res).toBeNull()
    expect(logAuditMock).not.toHaveBeenCalled()
  })

  it("returns null for a portal client", async () => {
    const res = await refuseReadOnlyDocumentWrite({
      caller: client,
      documentId: "selfie",
      tenantId: "tenant-1",
      action: "selfie",
      req: req(),
    })
    expect(res).toBeNull()
    expect(logAuditMock).not.toHaveBeenCalled()
  })
})
