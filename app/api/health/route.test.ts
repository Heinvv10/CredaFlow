import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { queryRaw, heartbeats, outboxFailures, disk } = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  heartbeats: vi.fn(),
  outboxFailures: vi.fn(),
  disk: { failWrite: false, corrupt: false, files: new Map<string, Buffer>() },
}))

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $queryRaw: queryRaw,
    cronHeartbeat: { findMany: heartbeats },
    webhookOutboxFailure: { count: outboxFailures },
  },
}))

// An operator session (lib/operator/) also gets the detail; read only when a cookie is sent.
const { authMock } = vi.hoisted(() => ({ authMock: vi.fn() }))
vi.mock("@/lib/auth", () => ({ auth: authMock }))

vi.mock("@/lib/storage", () => ({
  storageEncryptionEnabled: () => Boolean(process.env.UPLOADS_ENC_KEY),
  saveFileToManagedPath: async (buf: Buffer, _mime: string, key: string) => {
    if (disk.failWrite) throw Object.assign(new Error("ENOSPC: no space left on device, open '/app/uploads/x'"), { code: "ENOSPC" })
    disk.files.set(key, disk.corrupt ? Buffer.from("x") : buf)
    return { storagePath: key, fileSize: buf.length }
  },
  readFile: async (p: string) => disk.files.get(p)!,
  deleteManagedFileStrict: async (p: string) => { disk.files.delete(p) },
}))

import { GET } from "./route"

const SECRET = "cron-secret-for-tests-0123456789"
const PUBLIC_KEYS = ["builtAt", "checkedAt", "commit", "mode", "status"]

beforeEach(() => {
  disk.failWrite = false
  disk.corrupt = false
  disk.files.clear()
  queryRaw.mockResolvedValue([{ "?column?": 1 }])
  heartbeats.mockResolvedValue([])
  outboxFailures.mockResolvedValue(0)
  vi.stubEnv("CRON_SECRET", SECRET)
  vi.stubEnv("APP_MODE", "staff")
  vi.stubEnv("UPLOADS_ENC_KEY", "set")
  vi.spyOn(console, "error").mockImplementation(() => undefined)
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
const operator = () => getHealth({ "x-cron-secret": SECRET })

describe("/api/health, public", () => {
  it("returns status and the deploy marker only", async () => {
    vi.stubEnv("GIT_SHA", "bda437dcf6baaa139ce472483d1f0110e4854e30")
    vi.stubEnv("BUILD_TIME", "2026-05-12T10:30:00.000Z")

    const { response, body } = await getHealth()

    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(Object.keys(body).sort()).toEqual(PUBLIC_KEYS)
    expect(body).toMatchObject({ status: "ok", commit: "bda437dcf6baaa139ce472483d1f0110e4854e30", builtAt: "2026-05-12T10:30:00.000Z" })
    expect(new Date(body.checkedAt).toString()).not.toBe("Invalid Date")
    expect(disk.files.size).toBe(0)
    expect(heartbeats).not.toHaveBeenCalled()
  })

  it("answers 503 when the database is down, without saying why", async () => {
    queryRaw.mockRejectedValue(new Error("connect ECONNREFUSED 10.0.0.5:5432"))
    const { response, body } = await getHealth()
    expect(response.status).toBe(503)
    expect(Object.keys(body).sort()).toEqual(PUBLIC_KEYS)
    expect(JSON.stringify(body)).not.toMatch(/ECONNREFUSED|10\.0\.0\.5|database/)
  })

  it("answers 503 when storage fails, without the error or a path", async () => {
    disk.failWrite = true
    const { response, body } = await getHealth()
    expect(response.status).toBe(503)
    expect(JSON.stringify(body)).not.toMatch(/ENOSPC|uploads|storage/)
  })

  it("a wrong secret gets the public answer", async () => {
    const { body } = await getHealth({ "x-cron-secret": "nope" })
    expect(Object.keys(body).sort()).toEqual(PUBLIC_KEYS)
  })
})

describe("/api/health, operator (x-cron-secret)", () => {
  // Review round 2: an outbox event a trigger could not write is a lost
  // webhook; recent ones are a warning (not a failure of the check).
  it("warns while webhook events were lost in the last 24 hours, with the count", async () => {
    outboxFailures.mockResolvedValue(3)
    const { response, body } = await operator()
    expect(response.status).toBe(200)
    expect(body.warnings).toContain("webhook_outbox_failures")
    expect(body.detail.webhookOutboxFailures24h).toBe(3)
    const since = outboxFailures.mock.calls[0][0].where.createdAt.gte as Date
    expect(Date.now() - since.getTime()).toBeGreaterThanOrEqual(24 * 3600_000 - 1000)
  })

  it("names each check", async () => {
    const { body } = await operator()
    expect(body).toMatchObject({ status: "ok", checks: { database: "ok", storage: "ok", storageEncryption: "on", cron: "ok" }, warnings: [] })
  })

  it("names the failed check: storage that does not read back", async () => {
    disk.corrupt = true
    const { response, body } = await operator()
    expect(response.status).toBe(503)
    expect(body.checks.storage).toBe("error")
  })

  it("warns, without failing, on stale cron jobs and encryption at rest being off, with per-job detail", async () => {
    vi.stubEnv("UPLOADS_ENC_KEY", "")
    vi.spyOn(process, "uptime").mockReturnValue(10 * 24 * 3600)
    heartbeats.mockResolvedValue([{ job: "/api/cron/webhook-deliveries", lastSucceededAt: new Date(Date.now() - 3600_000), lastStatus: 200 }])
    const { response, body } = await operator()
    expect(response.status).toBe(200)
    expect(body.checks.cron).toBe("stale")
    expect(body.warnings).toEqual(["cron_stale", "storage_encryption_off"])
    expect(body.detail.cronJobs.find((j: { job: string }) => j.job === "webhook-deliveries").stale).toBe(true)
  })

  it("does not judge cron on the client container", async () => {
    vi.stubEnv("APP_MODE", "client")
    const { body } = await operator()
    expect(body.checks.cron).toBe("not_scheduled")
    expect(heartbeats).not.toHaveBeenCalled()
  })
})

// Platform setup warnings (W0): the runtime role bypasses row-level security,
// or env credentials are owned by no tenant. Shown with the other detail to an
// x-cron-secret caller or an operator session; the public answer is unchanged.
describe("/api/health, platform setup warnings", () => {
  const OPERATOR_SESSION = { user: { id: "op1", role: "OPERATOR_SUPPORT", tenantId: null } }
  const withCookie = { cookie: "authjs.session-token=synthetic" }
  /** pg_roles answers as `role`; every other query (SELECT 1) as before. */
  const roleIs = (role: { su: boolean; bypass: boolean }) =>
    queryRaw.mockImplementation(async (strings: TemplateStringsArray) =>
      strings.join("").includes("pg_roles") ? [role] : [{ "?column?": 1 }])

  beforeEach(() => {
    authMock.mockReset().mockResolvedValue(null)
    vi.spyOn(console, "warn").mockImplementation(() => undefined)
  })

  it("an operator session gets the checks and warnings, the RLS one included", async () => {
    roleIs({ su: true, bypass: false })
    authMock.mockResolvedValue(OPERATOR_SESSION)
    const { body } = await getHealth(withCookie)
    expect(body.checks).toMatchObject({ database: "ok" })
    expect(body.warnings).toContain("db_role_bypasses_rls")
  })

  it("an x-cron-secret caller gets them too, without any session", async () => {
    roleIs({ su: false, bypass: true })
    const { body } = await operator()
    expect(body.warnings).toContain("db_role_bypasses_rls")
    expect(authMock).not.toHaveBeenCalled()
  })

  it("warns an operator when env credentials are set but owned by no tenant", async () => {
    roleIs({ su: false, bypass: false })
    vi.stubEnv("STITCH_CLIENT_ID", "env-client")
    vi.stubEnv("ENV_CREDENTIALS_TENANT_SLUG", "")
    authMock.mockResolvedValue(OPERATOR_SESSION)
    expect((await getHealth(withCookie)).body.warnings).toContain("env_credentials_unowned")
  })

  it("keeps the public answer minimal: no cookie, lender staff, or an unreadable session", async () => {
    roleIs({ su: true, bypass: false })
    vi.stubEnv("STITCH_CLIENT_ID", "env-client")
    expect(Object.keys((await getHealth()).body).sort()).toEqual(PUBLIC_KEYS)
    expect(authMock).not.toHaveBeenCalled()
    authMock.mockResolvedValue({ user: { id: "u1", role: "SUPER_ADMIN", tenantId: "t1" } })
    expect(Object.keys((await getHealth(withCookie)).body).sort()).toEqual(PUBLIC_KEYS)
    authMock.mockRejectedValue(new Error("session decode failed"))
    const failed = await getHealth(withCookie)
    expect(failed.response.status).toBe(200)
    expect(Object.keys(failed.body).sort()).toEqual(PUBLIC_KEYS)
  })

  it("logs the RLS warning once per process, even when only public probes ask", async () => {
    vi.resetModules()
    const { GET: freshGet } = await import("./route")
    roleIs({ su: true, bypass: false })
    await freshGet(new Request("http://localhost/api/health"))
    await freshGet(new Request("http://localhost/api/health"))
    const rls = vi.mocked(console.warn).mock.calls.filter(([m]) => String(m).includes("row-level security is not enforced"))
    expect(rls).toHaveLength(1)
  })
})
