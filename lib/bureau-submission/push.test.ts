import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const renderSubmissionMock = vi.fn()
const logAuditMock = vi.fn()
vi.mock("./render", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./render")>()),
  renderSubmission: (...args: unknown[]) => renderSubmissionMock(...args),
}))
vi.mock("@/lib/audit", () => ({
  AuditAction: { BUREAU_SUBMISSION_PUSHED: "BUREAU_SUBMISSION_PUSHED" },
  logAudit: (params: unknown) => logAuditMock(params),
}))

import { pushConfigured, pushSubmission } from "./push"
import { sha256Of } from "./render"
import { localDirectoryTransport, sftpTransport, SubmissionTransportError, type SubmissionTransport } from "./transport"

const db = {} as Parameters<typeof pushSubmission>[0]
const args = { tenantId: "tenant-synthetic", submissionId: "submission-1", mode: "TEST" as const }
const rendered = { id: "submission-1", fileName: "TT0109_ALL_T702_D_20260820_1_1", content: "SYNTHETIC LINE\r\n", intact: true, superseded: false, recordCount: 1 }

let outbox: string
beforeEach(() => {
  outbox = mkdtempSync(join(tmpdir(), "bureau-outbox-"))
  renderSubmissionMock.mockReset().mockResolvedValue(rendered)
  logAuditMock.mockReset().mockResolvedValue(undefined)
})
afterEach(() => {
  rmSync(outbox, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

const recording = (): SubmissionTransport & { files: string[] } => {
  const files: string[] = []
  return { id: "recording", modes: ["TEST"], files, async deliver(file) { files.push(file.content); return { location: "memory" } } }
}

describe("pushSubmission", () => {
  it("LIVE stays refused: no LIVE transport exists, and push never resolves one for LIVE", async () => {
    expect(pushConfigured()).toBe(false)
    vi.stubEnv("BUREAU_SUBMISSION_TEST_OUTBOX", outbox)
    await expect(pushSubmission(db, { ...args, mode: "LIVE" })).resolves.toBe("NOT_CONFIGURED")
    expect(renderSubmissionMock).not.toHaveBeenCalled()
  })

  it("is NOT_CONFIGURED with no TEST outbox declared, as before", async () => {
    vi.stubEnv("BUREAU_SUBMISSION_TEST_OUTBOX", "")
    await expect(pushSubmission(db, args)).resolves.toBe("NOT_CONFIGURED")
  })

  it("delivers the ledger's re-rendered bytes to the TEST outbox and audits identifiers only", async () => {
    vi.stubEnv("BUREAU_SUBMISSION_TEST_OUTBOX", outbox)
    await expect(pushSubmission(db, args)).resolves.toBe("DELIVERED")
    const written = readFileSync(join(outbox, rendered.fileName), "latin1")
    expect(sha256Of(written)).toBe(sha256Of(rendered.content))
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({
      action: "BUREAU_SUBMISSION_PUSHED",
      newValue: expect.objectContaining({ outcome: "DELIVERED", mode: "TEST", transport: "local-directory", recordCount: 1 }),
    }))
    expect(JSON.stringify(logAuditMock.mock.calls)).not.toContain("SYNTHETIC LINE")
  })

  it("refuses a file whose ledger no longer re-renders to the stored hash, or that a newer TEST file replaced", async () => {
    const transport = recording()
    renderSubmissionMock.mockResolvedValueOnce({ ...rendered, intact: false })
    await expect(pushSubmission(db, args, () => transport)).resolves.toBe("REFUSED")
    renderSubmissionMock.mockResolvedValueOnce({ ...rendered, superseded: true })
    await expect(pushSubmission(db, args, () => transport)).resolves.toBe("REFUSED")
    expect(transport.files).toHaveLength(0)
  })

  it("reports a delivery failure instead of throwing after the ledger is committed", async () => {
    const failing: SubmissionTransport = {
      id: "failing", modes: ["TEST"], async deliver() { throw new SubmissionTransportError("DELIVERY_FAILED", "synthetic") },
    }
    await expect(pushSubmission(db, args, () => failing)).resolves.toBe("FAILED")
    expect(logAuditMock.mock.calls[0][0].newValue).toMatchObject({ outcome: "FAILED", code: "DELIVERY_FAILED" })
  })
})

describe("transports", () => {
  it("the local outbox never overwrites a delivered file", async () => {
    const transport = localDirectoryTransport(outbox)
    const file = { fileName: "SYNTHETIC_FILE", content: "A\r\n", sha256: sha256Of("A\r\n") }
    await transport.deliver(file)
    await expect(transport.deliver({ ...file, content: "B\r\n" })).rejects.toMatchObject({ code: "DELIVERY_FAILED" })
    expect(readFileSync(join(outbox, "SYNTHETIC_FILE"), "latin1")).toBe("A\r\n")
  })

  it("the local outbox refuses a deployed build, a relative directory and a path-like file name", async () => {
    expect(() => localDirectoryTransport("relative/outbox")).toThrow(SubmissionTransportError)
    await expect(localDirectoryTransport(outbox).deliver({ fileName: "../escape", content: "", sha256: "" }))
      .rejects.toMatchObject({ code: "DELIVERY_FAILED" })
    vi.stubEnv("NODE_ENV", "production")
    await expect(localDirectoryTransport(outbox).deliver({ fileName: "SYNTHETIC_FILE", content: "", sha256: "" }))
      .rejects.toMatchObject({ code: "NOT_CONFIGURED" })
  })

  it("the SFTP skeleton carries no mode and refuses every delivery", async () => {
    const sftp = sftpTransport({
      host: "bureau.invalid", port: 22, username: "synthetic", privateKeySealed: "enc:v1:x:y:z",
      hostKeySha256: "0".repeat(64), remoteDirectory: "/in", pgpPublicKey: null,
    })
    expect(sftp.modes).toEqual([])
    await expect(sftp.deliver({ fileName: "F", content: "", sha256: "" })).rejects.toMatchObject({ code: "NOT_IMPLEMENTED" })
  })
})
