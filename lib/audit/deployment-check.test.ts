import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/prisma", () => ({ prisma: {} }))
vi.mock("@/lib/observability/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }))

import { auditSetupRefusal, auditSetupWarnings } from "./deployment-check"

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
