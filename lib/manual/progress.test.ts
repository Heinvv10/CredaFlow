import { it, expect, vi, beforeEach } from "vitest"

const upsert = vi.fn()
const del = vi.fn()
const findMany = vi.fn()
const logAudit = vi.fn()

vi.mock("@/lib/prisma", () => ({
  prisma: { manualProgress: { upsert: (a: unknown) => upsert(a), delete: (a: unknown) => del(a), deleteMany: (a: unknown) => del(a), findMany: (a: unknown) => findMany(a) } },
}))
vi.mock("@/lib/audit", () => ({
  logAudit: (a: unknown) => logAudit(a),
  AuditAction: { MANUAL_LESSON_COMPLETED: "MANUAL_LESSON_COMPLETED", MANUAL_LESSON_REOPENED: "MANUAL_LESSON_REOPENED" },
}))

import { setLessonComplete, getCompletedSlugs } from "./progress"

beforeEach(() => vi.clearAllMocks())

it("marks a lesson complete and audits it", async () => {
  upsert.mockResolvedValue({ id: "p1" })
  const res = await setLessonComplete({ tenantId: "t1", userId: "u1", userEmail: "a@b.c", lessonSlug: "sign-in-2fa", complete: true })
  expect(res).toEqual({ completed: true })
  expect(upsert).toHaveBeenCalledOnce()
  expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "t1", userId: "u1", entityId: "sign-in-2fa" }))
})

it("marks a lesson incomplete (delete) and audits it", async () => {
  del.mockResolvedValue({ count: 1 })
  const res = await setLessonComplete({ tenantId: "t1", userId: "u1", userEmail: "a@b.c", lessonSlug: "sign-in-2fa", complete: false })
  expect(res).toEqual({ completed: false })
  expect(del).toHaveBeenCalledOnce()
  expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ entityId: "sign-in-2fa", action: "MANUAL_LESSON_REOPENED" }))
})

it("rejects an unknown lesson slug", async () => {
  await expect(setLessonComplete({ tenantId: "t1", userId: "u1", userEmail: "a@b.c", lessonSlug: "nope", complete: true })).rejects.toThrow("Unknown lesson")
  expect(upsert).not.toHaveBeenCalled()
})

it("returns completed slugs for a user", async () => {
  findMany.mockResolvedValue([{ lessonSlug: "sign-in-2fa" }, { lessonSlug: "dashboard-triage" }])
  const slugs = await getCompletedSlugs("u1")
  expect(slugs).toEqual(["sign-in-2fa", "dashboard-triage"])
  expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: "u1" } }))
})
