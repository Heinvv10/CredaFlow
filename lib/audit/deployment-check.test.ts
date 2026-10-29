import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({ query: vi.fn(), error: vi.fn(), warn: vi.fn() }))
vi.mock("@/lib/prisma", () => ({ prisma: { $queryRaw: (...a: unknown[]) => h.query(...a) } }))
vi.mock("@/lib/observability/logger", () => ({ logger: { warn: h.warn, error: h.error, info: vi.fn(), debug: vi.fn() } }))

import { auditSetupRefusal, auditSetupWarnings, enforceAuditSetupAtBoot, privilegedRoleAllowance } from "./deployment-check"

const KEY = "k".repeat(40)
const WORKER = { AUDIT_CHAIN_KEY: KEY, CRON_SCHEDULER: "on", APP_MODE: "all" }
const WEB = { CRON_SCHEDULER: "off", APP_MODE: "staff" }
const clean = { owns: 0, su: false, privileged: false, writes: false, workerFns: false }
const db = (row: Partial<typeof clean>) => ({ $queryRaw: async () => [{ ...clean, ...row }] }) as never

describe("auditSetupWarnings", () => {
  it("is quiet for a keyed worker and for a keyless web with the web grants", async () => {
    expect(await auditSetupWarnings(db({ workerFns: true }), WORKER)).toEqual([])
    expect(await auditSetupWarnings(db({}), WEB)).toEqual([])
  })

  it("warns when the role owns tables or the redactor, is a superuser, can create roles or objects, or can write the evidence", async () => {
    expect(await auditSetupWarnings(db({ owns: 2, su: true, privileged: true, writes: true }), WORKER)).toEqual([
      "audit_runtime_role_owns_tables", "audit_runtime_role_superuser", "audit_runtime_role_privileged", "audit_runtime_role_can_write_evidence",
    ])
  })

  it("wants the key on the worker only, and the worker functions off the web login", async () => {
    expect(await auditSetupWarnings(db({}), { ...WORKER, AUDIT_CHAIN_KEY: "short" })).toEqual(["audit_chain_key_missing"])
    expect(await auditSetupWarnings(db({ workerFns: true }), { ...WEB, AUDIT_CHAIN_KEY: KEY })).toEqual(["audit_chain_key_on_web", "audit_web_holds_worker_functions"])
  })
})

describe("auditSetupRefusal", () => {
  const prod = { NODE_ENV: "production" }
  it("refuses a production process whose role could undo the audit protections", () => {
    for (const w of ["audit_runtime_role_owns_tables", "audit_runtime_role_superuser", "audit_runtime_role_privileged", "audit_runtime_role_can_write_evidence"] as const) {
      expect(auditSetupRefusal([w], prod), w).toEqual([w])
    }
  })

  it("only warns for the key and the web grants, outside production, or with the explicit opt-out", () => {
    expect(auditSetupRefusal(["audit_chain_key_missing", "audit_web_holds_worker_functions", "audit_chain_key_on_web"], prod)).toBeNull()
    expect(auditSetupRefusal(["audit_runtime_role_superuser"], { NODE_ENV: "development" })).toBeNull()
    expect(auditSetupRefusal(["audit_runtime_role_superuser"], { ...prod, AUDIT_ALLOW_PRIVILEGED_DB_ROLE: "1" })).toBeNull()
  })
})

describe("the privileged-role allowance", () => {
  it("comes from AUDIT_ALLOW_PRIVILEGED_DB_ROLE=1 or a demo stack, nothing else", () => {
    expect(privilegedRoleAllowance({ AUDIT_ALLOW_PRIVILEGED_DB_ROLE: "1" })).toBe("AUDIT_ALLOW_PRIVILEGED_DB_ROLE=1")
    expect(privilegedRoleAllowance({ DEMO_MODE: "true" })).toBe("DEMO_MODE=true")
    for (const env of [{}, { AUDIT_ALLOW_PRIVILEGED_DB_ROLE: "true" }, { DEMO_MODE: "false" }, { AUDIT_ALLOW_PRIVILEGED_DB_ROLE: "0" }]) expect(privilegedRoleAllowance(env)).toBeNull()
  })

  it("lets a demo stack run in production, and the warning list says it is allowed", async () => {
    expect(auditSetupRefusal(["audit_runtime_role_superuser"], { NODE_ENV: "production", DEMO_MODE: "true" })).toBeNull()
    expect(await auditSetupWarnings(db({ su: true }), { ...WORKER, DEMO_MODE: "true" })).toEqual(["audit_runtime_role_superuser", "audit_privileged_role_allowed"])
    expect(await auditSetupWarnings(db({}), { ...WORKER, DEMO_MODE: "true" })).toEqual([]) // nothing to allow, nothing said
  })
})

describe("enforceAuditSetupAtBoot", () => {
  const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never)
  const PROD = { ...WORKER, NODE_ENV: "production" }
  beforeEach(() => { vi.useFakeTimers(); h.query.mockReset(); h.error.mockClear(); h.warn.mockClear(); exit.mockClear() })
  afterEach(() => { vi.useRealTimers() })
  const run = async (env: Record<string, string>) => {
    const done = enforceAuditSetupAtBoot(env)
    await vi.runAllTimersAsync()
    await done
  }

  it("exits a production process whose role could undo the protections", async () => {
    h.query.mockResolvedValue([{ owns: 1, su: false, privileged: false, writes: false, workerFns: true }])
    await run(PROD)
    expect(exit).toHaveBeenCalledWith(1)
  })

  it("fails closed when the check cannot run: retried, then a production process refuses to start", async () => {
    h.query.mockRejectedValue(new Error("connection refused"))
    await run(PROD)
    expect(h.query).toHaveBeenCalledTimes(4)
    expect(exit).toHaveBeenCalledWith(1)
  })

  it("does not exit outside production when the check cannot run, and recovers when a retry works", async () => {
    h.query.mockRejectedValue(new Error("connection refused"))
    await run({ ...WORKER, NODE_ENV: "development" })
    expect(exit).not.toHaveBeenCalled()
    h.query.mockReset().mockRejectedValueOnce(new Error("blip")).mockResolvedValue([{ owns: 0, su: false, privileged: false, writes: false, workerFns: true }])
    await run(PROD)
    expect(exit).not.toHaveBeenCalled()
  })

  it("logs the allowance loudly at every boot, and goes on", async () => {
    h.query.mockResolvedValue([{ owns: 0, su: true, privileged: false, writes: false, workerFns: true }])
    await run({ ...PROD, AUDIT_ALLOW_PRIVILEGED_DB_ROLE: "1" })
    expect(exit).not.toHaveBeenCalled()
    expect(h.error).toHaveBeenCalledWith(expect.stringContaining("PRIVILEGED DATABASE ROLE ALLOWED"), expect.anything())
    h.error.mockClear()
    await run({ ...PROD, DEMO_MODE: "true" })
    expect(h.error).toHaveBeenCalledWith(expect.stringContaining("DEMO_MODE=true"), expect.anything())
  })
})
