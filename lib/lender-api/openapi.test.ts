import { describe, expect, it } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { buildOpenApiDocument } from "./openapi"
import { toApiApplication, toApiClient, toApiLoan, toApiPayment, toApiScheduleItem } from "./serializers"

const V1_DIR = path.join(__dirname, "..", "..", "app", "api", "v1")
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const

interface RouteOp { path: string; method: string; scope: string | null }

/** Every exported handler under app/api/v1, with the scope its withApiKey call checks. */
function routeOps(): RouteOp[] {
  const ops: RouteOp[] = []
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) walk(full)
      else if (e.name === "route.ts") {
        const src = fs.readFileSync(full, "utf8")
        const rel = path.relative(V1_DIR, path.dirname(full)).split(path.sep).filter(Boolean)
        const apiPath = "/api/v1/" + rel.map((s) => s.replace(/^\[(.+)\]$/, "{$1}")).join("/")
        for (const m of METHODS) {
          const at = src.search(new RegExp(`export async function ${m}\\b`))
          if (at < 0) continue
          const scope = /withApiKey\(req,\s*"([a-z:]+)"/.exec(src.slice(at))
          ops.push({ path: apiPath.replace(/\/$/, ""), method: m.toLowerCase(), scope: scope ? scope[1] : null })
        }
      }
    }
  }
  walk(V1_DIR)
  return ops
}

const doc = buildOpenApiDocument()
type Op = { "x-required-scope"?: string; security?: unknown[] }
const specOps = Object.entries(doc.paths).flatMap(([p, item]) =>
  Object.entries(item as Record<string, Op>).map(([method, op]) => ({ path: p, method, scope: op["x-required-scope"] ?? null })))

describe("OpenAPI document vs the /api/v1 routes", () => {
  it("finds the routes (guards against the walker silently finding none)", () => {
    expect(routeOps().length).toBeGreaterThanOrEqual(11)
  })

  it("documents every route and method, with the scope the handler checks", () => {
    const missing = routeOps().filter((r) => !specOps.some((s) => s.path === r.path && s.method === r.method && s.scope === r.scope))
    expect(missing, "routes absent from (or with a different scope in) lib/lender-api/openapi.ts").toEqual([])
  })

  it("documents nothing that is not a route", () => {
    const routes = routeOps()
    const phantom = specOps.filter((s) => !routes.some((r) => r.path === s.path && r.method === s.method))
    expect(phantom).toEqual([])
  })

  it("puts every data route behind a key; only the document itself is open", () => {
    const open = routeOps().filter((r) => r.scope === null).map((r) => r.path)
    expect(open).toEqual(["/api/v1/openapi.json"])
  })

  it("is OpenAPI 3.1 whose every $ref resolves", () => {
    expect(doc.openapi).toBe("3.1.0")
    const refs = [...JSON.stringify(doc).matchAll(/"\$ref":"#\/components\/schemas\/([A-Za-z]+)"/g)].map((m) => m[1])
    expect(refs.length).toBeGreaterThan(0)
    for (const r of refs) expect(Object.keys(doc.components.schemas), r).toContain(r)
  })
})

const d = new Date("2026-10-14T08:00:00.000Z")
type Schema = { properties: Record<string, unknown>; required: readonly string[] }
function conforms(value: Record<string, unknown>, schemaName: keyof typeof doc.components.schemas) {
  const schema = doc.components.schemas[schemaName] as unknown as Schema
  expect(Object.keys(value).filter((k) => !(k in schema.properties)), `${schemaName}: undocumented fields`).toEqual([])
  expect(schema.required.filter((k) => !(k in value)), `${schemaName}: required fields missing`).toEqual([])
}

describe("serializers match the documented schemas", () => {
  const client = {
    id: "c1", reference: "CL-1", firstName: "Test", lastName: "Person", idNumber: "0000000000087",
    email: "test@example.invalid", phone: "+27000000000", dateOfBirth: null, kycStatus: "PENDING" as const, createdAt: d,
  }
  it("Client, with and without pii:read", () => {
    conforms(toApiClient(client, { pii: false }), "Client")
    conforms(toApiClient(client, { pii: true }), "Client")
  })
  it("Application, Loan, ScheduleItem, Payment", () => {
    const application = {
      id: "a1", reference: "APP-1", clientId: "c1", entityId: null, productId: "p1", status: "DRAFT" as const,
      appliedAmount: 100000, appliedTermDays: 30, purpose: "x", submittedAt: null, approvedAt: null, disbursedAt: null, createdAt: d, updatedAt: d,
    }
    conforms(toApiApplication(application, { pii: true }), "Application")
    conforms(toApiApplication(application, { pii: false }), "Application")
    expect(toApiApplication(application, { pii: false })).not.toHaveProperty("purpose")
    conforms(toApiLoan({
      id: "l1", reference: "LN-1", applicationId: "a1", clientId: "c1", entityId: null, productId: "p1", contractType: "LOAN",
      status: "ACTIVE", principal: 1, totalInterest: 1, initiationFee: 1, totalRepayable: 3, outstandingPrincipal: 1, totalPaid: 0,
      arrearsAmount: 0, daysInArrears: 0, interestRatePm: 0.05, interestModel: "FLAT", startDate: d, maturityDate: d,
      nextPaymentDate: null, closedAt: null, createdAt: d,
    }), "Loan")
    conforms(toApiScheduleItem({
      id: "s1", installmentNo: 1, dueDate: d, principalDue: 1, interestDue: 1, feesDue: 0, creditLifePremiumDue: 0,
      totalDue: 2, totalPaid: 0, status: "PENDING", paidAt: null,
    }), "ScheduleItem")
    const payment = {
      id: "py1", loanId: "l1", amount: 100, paymentMethod: "EFT" as const, reference: "synthetic ref", allocationStatus: "ALLOCATED" as const,
      receivedAt: d, reversed: false, reversedAt: null, createdAt: d,
    }
    conforms(toApiPayment(payment, { pii: true }), "Payment")
    conforms(toApiPayment(payment, { pii: false }), "Payment")
    expect(toApiPayment(payment, { pii: false })).not.toHaveProperty("reference")
  })
})
