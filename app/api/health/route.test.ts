import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { queryRaw, heartbeats, disk } = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  heartbeats: vi.fn(),
  disk: { failWrite: false, corrupt: false, files: new Map<string, Buffer>() },
}))

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $queryRaw: queryRaw,
    cronHeartbeat: { findMany: heartbeats },
  },
}))

vi.mock("@/lib/storage", () => ({
  storageEncryptionEnabled: () => Boolean(process.env.UPLOADS_ENC_KEY),
  saveFileToManagedPath: async (buf: Buffer, _mime: string, key: string) => {
    if (disk.failWrite) throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" })
    disk.files.set(key, disk.corrupt ? Buffer.from("x") : buf)
    return { storagePath: key, fileSize: buf.length }
  },
  readFile: async (p: string) => disk.files.get(p)!,
  deleteManagedFileStrict: async (p: string) => { disk.files.delete(p) },
}))

import { GET } from "./route"

beforeEach(() => {
  disk.failWrite = false
  disk.corrupt = false
  disk.files.clear()
  queryRaw.mockResolvedValue([{ "?column?": 1 }])
  heartbeats.mockResolvedValue([])
  vi.stubEnv("CRON_SECRET", "cron-secret-for-tests-0123456789")
  vi.stubEnv("APP_MODE", "staff")
  vi.stubEnv("UPLOADS_ENC_KEY", "set")
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  queryRaw.mockReset()
  heartbeats.mockReset()
})

async function getHealth(headers: Record<string, string> = {}) {
  const response = await GET(new Request("http://localhost/api/health", { headers }))
  return { response, body: await response.json() }
}

describe("/api/health", () => {
  it("returns deploy marker metadata when the database is healthy", async () => {
    vi.stubEnv("GIT_SHA", "bda437dcf6baaa139ce472483d1f0110e4854e30")
    vi.stubEnv("BUILD_TIME", "2026-05-12T10:30:00.000Z")

    const { response, body } = await getHealth()

    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(body).toMatchObject({
      status: "ok",
      commit: "bda437dcf6baaa139ce472483d1f0110e4854e30",
      builtAt: "2026-05-12T10:30:00.000Z",
      checks: { database: "ok", storage: "ok", storageEncryption: "on", cron: "ok" },
      warnings: [],
    })
    expect(new Date(body.checkedAt).toString()).not.toBe("Invalid Date")
    expect(disk.files.size).toBe(0)
  })

  it("answers 503 when the database is down", async () => {
    queryRaw.mockRejectedValue(new Error("connection refused"))
    const { response, body } = await getHealth()
    expect(response.status).toBe(503)
    expect(body.status).toBe("error")
    expect(body.checks.database).toBe("error")
  })

  it("answers 503 when storage cannot write or does not read back what it wrote", async () => {
    disk.failWrite = true
    expect((await getHealth()).response.status).toBe(503)
    disk.failWrite = false
    disk.corrupt = true
    const { response, body } = await getHealth()
    expect(response.status).toBe(503)
    expect(body.checks.storage).toBe("error")
  })

  it("warns, without failing, on stale cron jobs and on encryption at rest being off", async () => {
    vi.stubEnv("UPLOADS_ENC_KEY", "")
    vi.spyOn(process, "uptime").mockReturnValue(10 * 24 * 3600)
    heartbeats.mockResolvedValue([{ job: "/api/cron/webhook-deliveries", lastSucceededAt: new Date(Date.now() - 3600_000), lastStatus: 200 }])
    const { response, body } = await getHealth()
    expect(response.status).toBe(200)
    expect(body.status).toBe("ok")
    expect(body.checks.cron).toBe("stale")
    expect(body.warnings).toEqual(["cron_stale", "storage_encryption_off"])
    expect(body.detail).toBeUndefined()
  })

  it("shows per-job detail only to a caller with the cron secret", async () => {
    const { body } = await getHealth({ "x-cron-secret": "cron-secret-for-tests-0123456789" })
    expect(body.detail.cronJobs.map((j: { job: string }) => j.job)).toContain("webhook-deliveries")
    const wrong = await getHealth({ "x-cron-secret": "nope" })
    expect(wrong.body.detail).toBeUndefined()
  })

  it("does not judge cron on the client container", async () => {
    vi.stubEnv("APP_MODE", "client")
    const { body } = await getHealth()
    expect(body.checks.cron).toBe("not_scheduled")
    expect(heartbeats).not.toHaveBeenCalled()
  })
})
