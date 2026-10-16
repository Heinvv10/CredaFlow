import { readdirSync } from "node:fs"
import path from "node:path"
import { describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import { LOAN_BOOK_APIS, LOAN_BOOK_PAGES } from "@/lib/security/loan-book-scope"

// The edge auth wrapper as identity: the default export IS the handler, and
// `req.auth` is the session it reads (as proxy.client-pages.test.ts).
vi.mock("@/lib/auth-edge", () => ({ auth: (handler: unknown) => handler }))
const proxy = (await import("./proxy")).default as unknown as (req: NextRequest) => Promise<Response>

function visit(pathname: string, role: string, method = "GET") {
  const req = new NextRequest(`http://localhost${pathname}`, { method, headers: { host: "localhost" } }) as NextRequest & { auth: unknown }
  req.auth = { user: { id: "user-1", role, tenantId: "tenant-1", totpEnrolmentRequired: false } }
  return proxy(req)
}
const location = (res: Response) => res.headers.get("location") ?? ""

// Fair Score audit (2026-10-16): an INSURANCE_OFFICER could open collections,
// asset finance and the board pack. It now reads insurance, clients and
// compliance basics, nothing of the loan book (view_loan_book).
describe("INSURANCE_OFFICER and the loan book", () => {
  it.each(LOAN_BOOK_PAGES.filter((p) => p !== "dashboard"))("is sent to the no-access page from /%s", async (page) => {
    for (const url of [`/${page}`, `/${page}/sample`]) {
      const res = await visit(url, "INSURANCE_OFFICER")
      expect([url, res.status, new URL(location(res)).pathname]).toEqual([url, 307, "/no-access"])
    }
  })

  it("lands on its clients list instead of the executive dashboard", async () => {
    const res = await visit("/dashboard", "INSURANCE_OFFICER")
    expect(new URL(location(res)).pathname).toBe("/clients")
  })

  it.each(LOAN_BOOK_APIS)("is refused 403 by /api/%s, reads and writes", async (api) => {
    for (const method of ["GET", "POST", "PATCH", "DELETE"]) {
      expect([method, (await visit(`/api/${api}/sample`, "INSURANCE_OFFICER", method)).status]).toEqual([method, 403])
    }
  })

  it.each(["/clients", "/clients/sample", "/insurance", "/insurance/claims", "/compliance", "/compliance/ncr-return", "/settings/security", "/learn", "/no-access"])(
    "still opens %s", async (url) => {
      const res = await visit(url, "INSURANCE_OFFICER")
      expect([url, res.status]).toEqual([url, 200])
    },
  )

  it.each(["/api/clients/sample", "/api/insurance/claims", "/api/compliance/ncr-return", "/api/notifications"])(
    "still reaches %s", async (url) => {
      expect((await visit(url, "INSURANCE_OFFICER")).status).toBe(200)
    },
  )
})

describe("every other staff role keeps the loan book", () => {
  it.each(["READONLY", "COLLECTIONS_OFFICER", "COLLECTIONS_AGENT", "CREDIT_OFFICER", "LOAN_ADMIN", "BRANCH_MANAGER", "ADMIN", "SUPER_ADMIN"])(
    "%s passes the proxy on every loan-book page and API", async (role) => {
      for (const page of LOAN_BOOK_PAGES) expect([page, (await visit(`/${page}`, role)).status]).toEqual([page, 200])
      for (const api of LOAN_BOOK_APIS) expect([api, (await visit(`/api/${api}/sample`, role)).status]).toEqual([api, 200])
    },
  )
})

// Every top-level staff page and API is classified: in the loan book, or open
// to INSURANCE_OFFICER on purpose. A new one fails here until it is decided.
const OPEN_PAGES = ["clients", "compliance", "inbox", "insurance", "learn", "no-access", "settings"]
const OPEN_APIS = [
  "admin", "agent-hub", "audit", "auth", "automation", "branches", "clients", "complaints", "compliance", "cron",
  "documents", "dsar", "email", "health", "inbox", "insurance", "insurers", "integrations", "messaging",
  "notifications", "operator", "pasq-link", "portal", "products", "screening", "selfie-link", "settings",
  "signing-otp", "staff", "users", "v1", "webhooks", "website",
]
const dirs = (dir: string) =>
  readdirSync(path.join(__dirname, dir), { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("[")).map((e) => e.name).sort()

describe("the loan-book classification", () => {
  it("covers every top-level staff page", () => {
    expect(dirs("app/(dashboard)")).toEqual([...LOAN_BOOK_PAGES, ...OPEN_PAGES].sort())
  })

  it("covers every top-level API", () => {
    expect(dirs("app/api")).toEqual([...LOAN_BOOK_APIS, ...OPEN_APIS].sort())
  })
})
