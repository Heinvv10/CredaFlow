import { describe, expect, it, vi } from "vitest"
import {
  documentAccessTimelineEntries,
  mergeAuditTimeline,
  readTenantDocumentAccess,
  type AuditTimelineEntry,
  type DocumentAccessRow,
} from "./document-access-timeline"

const accessRow: DocumentAccessRow = {
  id: "access-1",
  documentId: "document-1",
  accessorType: "staff",
  accessorId: "staff-1",
  action: "download",
  ipAddress: "127.0.0.1",
  userAgent: "test-agent",
  createdAt: new Date("2026-07-22T10:00:00.000Z"),
}

describe("document access audit timeline", () => {
  it("reads access rows through a tenant-scoped ClientDocument join", async () => {
    const query = vi.fn().mockResolvedValue([accessRow])

    const rows = await readTenantDocumentAccess({ $queryRaw: query }, "tenant-1")

    expect(rows).toEqual([accessRow])
    expect(query).toHaveBeenCalledOnce()
    const sql = query.mock.calls[0][0] as { strings: readonly string[]; values: unknown[] }
    expect(sql.strings.join(" ")).toMatch(/INNER JOIN "ClientDocument"/)
    expect(sql.strings.join(" ")).toMatch(/LEFT JOIN "User"/)
    expect(sql.strings.join(" ")).toMatch(/document\."tenantId" =/)
    expect(sql.values).toEqual(["tenant-1", 100])
  })

  it("surfaces a staff document download with actor and evidence details", () => {
    const [entry] = documentAccessTimelineEntries([accessRow], [{
      id: "staff-1",
      name: "Review Officer",
      email: "review@acme-lending.example",
    }])

    expect(entry).toMatchObject({
      id: "document-access:access-1",
      userId: "staff-1",
      userName: "Review Officer",
      userEmail: "review@acme-lending.example",
      actorLabel: "review@acme-lending.example",
      action: "DOCUMENT_DOWNLOAD",
      entity: "ClientDocument",
      entityId: "document-1",
      ipAddress: "127.0.0.1",
      newValue: {
        accessorType: "staff",
        accessorId: "staff-1",
        accessAction: "download",
        userAgent: "test-agent",
      },
    })
  })

  it("labels client access as portal activity instead of system activity", () => {
    const [entry] = documentAccessTimelineEntries([{
      ...accessRow,
      accessorType: "client",
      accessorId: "client-1",
      action: "metadata",
    }], [])

    expect(entry).toMatchObject({
      userId: null,
      userName: "Client portal",
      actorLabel: "client portal client-1",
      action: "DOCUMENT_METADATA",
    })
  })

  it("keeps an unknown historical staff accessor identifiable by immutable id", () => {
    const [entry] = documentAccessTimelineEntries([accessRow], [])

    expect(entry).toMatchObject({
      userId: "staff-1",
      userName: "Staff user",
      actorLabel: "staff staff-1",
    })
  })

  it("labels automated generation as system activity rather than a staff user", () => {
    const [entry] = documentAccessTimelineEntries([{
      ...accessRow,
      accessorId: "system",
      action: "generated",
    }], [])

    expect(entry).toMatchObject({
      userId: null,
      userEmail: null,
      userName: "System",
      actorLabel: "system",
      action: "DOCUMENT_GENERATED",
    })
  })

  it("parameterises export filters without dropping the tenant predicate", async () => {
    const query = vi.fn().mockResolvedValue([])
    const from = new Date("2026-07-01T00:00:00.000Z")
    const to = new Date("2026-07-31T23:59:59.999Z")

    await readTenantDocumentAccess({ $queryRaw: query }, "tenant-1", {
      from,
      to,
      staffUserId: "staff-1",
      search: "DOCUMENT_DOWNLOAD",
      limit: 50_001,
    })

    const sql = query.mock.calls[0][0] as { strings: readonly string[]; values: unknown[] }
    expect(sql.strings.join(" ")).toMatch(/access\."createdAt" >=/)
    expect(sql.strings.join(" ")).toMatch(/access\."createdAt" <=/)
    expect(sql.strings.join(" ")).toMatch(/access\."accessorId" =/)
    expect(sql.strings.join(" ")).toMatch(/REGEXP_REPLACE/)
    expect(sql.values).toEqual([
      "tenant-1",
      from,
      to,
      "staff-1",
      ...Array(9).fill("%DOCUMENT_DOWNLOAD%"),
      50_001,
    ])
  })

  it("merges access and platform audit rows in exact descending time order", () => {
    const base = {
      userId: null,
      userEmail: null,
      userName: null,
      actorLabel: "system",
      entity: "Loan",
      entityId: "loan-1",
      oldValue: null,
      newValue: null,
      ipAddress: null,
    }
    const rows: AuditTimelineEntry[] = [
      { ...base, id: "older", action: "OLDER", createdAt: "2026-07-22T09:00:00.000Z" },
      { ...base, id: "newer", action: "NEWER", createdAt: "2026-07-22T11:00:00.000Z" },
    ]
    const documentRows = documentAccessTimelineEntries([accessRow], [])

    expect(mergeAuditTimeline(rows, documentRows).map((entry) => entry.id)).toEqual([
      "newer",
      "document-access:access-1",
      "older",
    ])
  })
})
