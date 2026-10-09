import { beforeEach, describe, expect, it, vi } from "vitest"
import path from "path"

const unlinkMock = vi.hoisted(() => vi.fn())

vi.mock("fs/promises", () => ({
  default: {
    mkdir: vi.fn(),
    writeFile: vi.fn(),
    unlink: (...args: unknown[]) => unlinkMock(...args),
    readFile: vi.fn(),
  },
}))

import { deleteManagedFileStrict } from "./storage"

beforeEach(() => {
  vi.clearAllMocks()
  unlinkMock.mockResolvedValue(undefined)
})

describe("deleteManagedFileStrict", () => {
  it("deletes only a direct child of managed storage", async () => {
    const managedPath = path.join(process.cwd(), "uploads", "section129-test.pdf")

    await deleteManagedFileStrict(managedPath)

    expect(unlinkMock).toHaveBeenCalledWith(managedPath)
  })

  it("treats an already deleted managed file as idempotent success", async () => {
    const error = Object.assign(new Error("missing"), { code: "ENOENT" })
    unlinkMock.mockRejectedValue(error)

    await expect(deleteManagedFileStrict(
      path.join(process.cwd(), "uploads", "section129-test.pdf"),
    )).resolves.toBeUndefined()
  })

  it("fails on I/O errors so the retention record stays locked", async () => {
    unlinkMock.mockRejectedValue(Object.assign(new Error("permission denied"), { code: "EACCES" }))

    await expect(deleteManagedFileStrict(
      path.join(process.cwd(), "uploads", "section129-test.pdf"),
    )).rejects.toThrow("permission denied")
  })

  it("refuses paths outside managed storage", async () => {
    await expect(deleteManagedFileStrict("/tmp/not-managed.pdf"))
      .rejects.toThrow("outside managed storage")
    expect(unlinkMock).not.toHaveBeenCalled()
  })
})
