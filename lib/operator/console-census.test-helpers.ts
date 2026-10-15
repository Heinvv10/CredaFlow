/**
 * The recording Prisma double for the operator console census
 * (console-census.test.ts). Every model call is recorded (model, operation,
 * args) and answered with a fixture; any borrower-data model returns rows
 * stuffed with SENTINEL values, so a page or route that reads one and shows
 * it gives itself away in its output.
 *
 * "Borrower data" is default-deny: every model that is not in PLATFORM_MODELS.
 * A new model is borrower data until someone argues otherwise here.
 */
export const SENTINEL = "SENTINEL-BORROWER"

/** Platform and lender-configuration models: no borrower personal data in them. */
export const PLATFORM_MODELS = new Set([
  "Operator", "Tenant", "TenantConfig", "User", "TenantSupportGrant",
  // Lender configuration the provisioning path seeds (templates, no borrower rows).
  "DocumentTemplate", "DocumentTemplateVersion", "MessageTemplate",
])

/** Operations that hand back no row: counts and sums, and writes the census reasons about separately. */
const AGGREGATE_OPS = new Set(["count", "groupBy", "aggregate"])
const READ_OPS = new Set(["findMany", "findFirst", "findFirstOrThrow", "findUnique", "findUniqueOrThrow"])

export type Call = { model: string; op: string; args: unknown }

export const T1 = "tenant-census-1"
export const OP = "operator-census-1"
export const ME = "operator-user-census-1"

export type Fixture = { grant: { id: string; expiresAt: Date } | null; operatorRole: "OPERATOR_ADMIN" | "OPERATOR_SUPPORT" }

const borrowerRow = (model: string) => ({
  id: `${model}-row`, tenantId: T1, firstName: SENTINEL, lastName: SENTINEL, idNumber: `${SENTINEL}-9999`,
  email: `${SENTINEL}@example.invalid`, reference: SENTINEL, status: "ACTIVE", principal: 1, arrearsAmount: 0,
  daysInArrears: 0, startDate: new Date(0), createdAt: new Date(0),
})

const tenantRow = () => ({
  id: T1, operatorId: OP, slug: "census-lender", name: "Census Lender", domain: null, status: "ACTIVE",
  createdAt: new Date(0), config: { brandName: "Census", primaryColor: "#123456", secondaryColor: "#234567", darkColor: "#0F1115" },
  operator: { name: "Census Operator" },
})

function answer(model: string, op: string, f: Fixture, args: unknown): unknown {
  // Lookups by a natural key the census creates (a new slug, a new email) find nothing.
  const where = (args as { where?: Record<string, unknown> } | undefined)?.where ?? {}
  if ((op === "findUnique" || op === "findFirst") && ((model === "Tenant" && "slug" in where) || (model === "User" && "email" in where))) return null
  // No earlier console action on record (the lender-admin reset's hourly limit).
  if (model === "AuditLog" && op === "count") return 0
  if (op === "groupBy") return [{ tenantId: T1, _count: { _all: 2 }, _max: { createdAt: new Date(0) }, _sum: { principal: 100 } }]
  if (op === "count") return 2
  if (op === "aggregate") return { _count: { _all: 2 }, _sum: {} }
  if (op === "updateMany" || op === "deleteMany") return { count: 1 }
  if (op === "create" || op === "update" || op === "upsert") return { id: `${model}-created` }
  if (!READ_OPS.has(op)) return null
  if (!PLATFORM_MODELS.has(model)) return op === "findMany" ? [borrowerRow(model)] : borrowerRow(model)
  const many = op === "findMany"
  switch (model) {
    case "Tenant": return many ? [tenantRow()] : tenantRow()
    case "Operator": return { id: OP, name: "Census Operator" }
    case "TenantSupportGrant": return many ? [] : f.grant
    case "User":
      return many ? [] : { id: ME, email: "me@operator.invalid", name: "Me", active: true, role: f.operatorRole, operatorId: OP, tenantId: null }
    default: return many ? [] : null
  }
}

/** A Prisma stand-in that records every call. */
export function recordingPrisma(calls: Call[], fixture: () => Fixture) {
  const models = new Map<string, unknown>()
  const client: Record<string, unknown> = new Proxy({}, {
    get(_t, key: string | symbol) {
      // Not a model: never a thenable, never an ES-module marker.
      if (typeof key !== "string" || key === "then" || key.startsWith("__") || key === "default" || key === "toJSON") return undefined
      if (key === "$transaction") {
        return async (arg: unknown) => (typeof arg === "function" ? (arg as (tx: unknown) => unknown)(client) : Promise.all(arg as unknown[]))
      }
      if (key.startsWith("$")) {
        return async (...args: unknown[]) => { calls.push({ model: "$raw", op: key, args }); return [] }
      }
      const model = key.charAt(0).toUpperCase() + key.slice(1)
      if (!models.has(model)) {
        models.set(model, new Proxy({}, {
          get(_m, op: string | symbol) {
            if (typeof op !== "string" || op === "then") return undefined
            return async (args: unknown) => {
              calls.push({ model, op, args })
              return answer(model, op, fixture(), args)
            }
          },
        }))
      }
      return models.get(model)
    },
  })
  return client
}

/** Calls that read borrower rows (not counts) or run raw SQL. */
export function borrowerReads(calls: Call[]): Call[] {
  return calls.filter((c) => c.model === "$raw" || (!PLATFORM_MODELS.has(c.model) && c.model !== "AuditLog" && !AGGREGATE_OPS.has(c.op)))
}

/**
 * Reads that would select a sealed provider credential, or a whole TenantConfig
 * row. The field list is passed in: importing it here would import @/lib/prisma
 * from inside its own mock.
 */
export function credentialReads(calls: Call[], sealedFields: readonly string[]): Call[] {
  return calls.filter((c) => {
    const json = JSON.stringify(c.args ?? {})
    return /"config":true/.test(json) || sealedFields.some((f) => json.includes(`"${f}":true`)) ||
      (c.model === "TenantConfig" && READ_OPS.has(c.op) && !json.includes('"select"'))
  })
}

/** The console's own audit rows it may count (a rate limit), never read. */
const COUNTABLE_CONSOLE_ACTIONS = new Set(["LENDER_ADMIN_RESET_LINK_SENT"])

/** AuditLog is written by the console, never read by it, except counting its own rows above. */
export function auditReads(calls: Call[]): Call[] {
  return calls.filter((c) => {
    if (c.model !== "AuditLog" || c.op === "create") return false
    const action = (c.args as { where?: { action?: unknown } } | undefined)?.where?.action
    return !(c.op === "count" && typeof action === "string" && COUNTABLE_CONSOLE_ACTIONS.has(action))
  })
}
