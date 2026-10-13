import { readdirSync, statSync } from "node:fs"
import path from "node:path"
import { describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

// proxy.ts wraps its handler in the edge auth; with the wrapper as identity
// the default export IS the handler, and `req.auth` is the session it reads.
vi.mock("@/lib/auth-edge", () => ({ auth: (handler: unknown) => handler }))

type Handler = (req: NextRequest) => Response | Promise<Response>
type Mode = "client" | "staff" | "all"

// APP_MODE is read once at module load, so each audience needs its own copy.
async function proxyIn(mode: Mode): Promise<Handler> {
  vi.stubEnv("APP_MODE", mode)
  vi.resetModules()
  const handler = (await import("./proxy")).default
  vi.unstubAllEnvs()
  return handler as unknown as Handler
}
const clientHost = await proxyIn("client")
const staffHost = await proxyIn("staff")
const singleHost = await proxyIn("all")
// Read per request by the quote-host check, so set after the modules load.
vi.stubEnv("FSP_QUICKQUOTE_HOSTS", "quote.test")

type Session = { user: { id: string; role: string; tenantId: string; totpEnrolmentRequired?: boolean } } | null
const STAFF: Session = { user: { id: "user-1", role: "LOAN_ADMIN", tenantId: "tenant-1", totpEnrolmentRequired: false } }
const CLIENT: Session = { user: { id: "client-1", role: "CLIENT", tenantId: "tenant-1" } }
const SESSIONS: Array<[string, Session]> = [["a staff session", STAFF], ["a CLIENT session", CLIENT], ["no session", null]]

async function visit(handler: Handler, pathname: string, session: Session, host = "localhost", method = "GET") {
  const req = new NextRequest(`http://${host}${pathname}`, { method, headers: { host } }) as NextRequest & { auth: unknown }
  req.auth = session
  return handler(req)
}

// --- the real route tree -----------------------------------------------------

const APP_DIR = path.join(__dirname, "app")

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name)
    return statSync(full).isDirectory() ? walk(full) : [full]
  })
}

/** URL for an app/ route file: route groups vanish, [param] becomes a sample value. */
function urlOf(file: string): string | null {
  const rel = path.relative(APP_DIR, file).split(path.sep)
  const leaf = rel.pop()!
  const isPage = leaf === "page.tsx"
  const isRoute = leaf === "route.ts"
  const isMetadata = rel.length === 0 && (leaf === "robots.ts" || leaf === "sitemap.ts")
  if (!isPage && !isRoute && !isMetadata) return null
  if (rel[0] === "api") return null
  if (isMetadata) return leaf === "robots.ts" ? "/robots.txt" : "/sitemap.xml"
  const segments = rel
    .filter((s) => !/^\(.*\)$/.test(s))
    .map((s) => (/^\[\.\.\./.test(s) ? "deep/link" : /^\[.*\]$/.test(s) ? "sample" : s))
  return "/" + segments.join("/")
}

const PAGES = [...new Set(walk(APP_DIR).map(urlOf).filter((u): u is string => u !== null))].sort()

// The pages the client host serves: the website, the portal, the one-time
// consumer links and the quote host. Everything else in app/ is the staff app.
// A new top-level page has to be classified here before this suite passes.
const CLIENT_HOST_SEGMENTS = new Set(["", "site", "portal", "pasq", "selfie", "quote", "llms.txt", "robots.txt", "sitemap.xml"])
// Staff sign-in pages are public, but not on the client host.
const STAFF_SIGN_IN = new Set(["/login", "/register", "/forgot-password", "/reset-password"])
const segmentOf = (url: string) => url.split("/")[1] ?? ""
const servedOnClientHost = (url: string) => CLIENT_HOST_SEGMENTS.has(segmentOf(url)) && !STAFF_SIGN_IN.has(url)
const hostFor = (url: string) => (segmentOf(url) === "quote" ? "quote.test" : "localhost")

describe("the page inventory", () => {
  it("is read from the real route tree", () => {
    expect(PAGES.length).toBeGreaterThan(60)
    expect(PAGES).toEqual(expect.arrayContaining([
      "/", "/inbox", "/contacts", "/learn", "/learn/sample", "/dashboard", "/settings/users",
      "/portal/loans", "/portal/login", "/site/qualify", "/pasq/sample", "/selfie/sample", "/login",
    ]))
  })
})

describe("pages on the client host (APP_MODE=client)", () => {
  describe.each(SESSIONS)("with %s", (_label, session) => {
    it.each(PAGES)("%s", async (url) => {
      const res = await visit(clientHost, url, session, hostFor(url))
      if (servedOnClientHost(url)) expect(res.status, url).not.toBe(404)
      else expect(res.status, url).toBe(404)
    })
  })

  it.each(["/inbox", "/contacts", "/learn", "/learn/some-lesson", "/inbox/reconciliation", "/contacts/c1"])(
    "does not render the staff page %s for a staff session",
    async (url) => {
      const res = await visit(clientHost, url, STAFF)
      expect(res.status).toBe(404)
    },
  )

  it.each(["/some-new-staff-page", "/admin", "/dashboard/anything"])("404s the unlisted page %s", async (url) => {
    expect((await visit(clientHost, url, STAFF)).status).toBe(404)
    expect((await visit(clientHost, url, null)).status).toBe(404)
  })

  it.each(["/", "/site/qualify", "/portal/login", "/portal/register", "/portal/forgot-password", "/pasq/tok", "/selfie/tok", "/robots.txt"])(
    "still serves the public page %s without a session",
    async (url) => {
      const res = await visit(clientHost, url, null)
      expect(res.status).toBe(200)
      expect(res.headers.get("x-middleware-next")).toBe("1")
    },
  )

  it("still serves the portal to a CLIENT session", async () => {
    const res = await visit(clientHost, "/portal/loans", CLIENT)
    expect(res.status).toBe(200)
    expect(res.headers.get("x-middleware-next")).toBe("1")
  })

  it("still sends an anonymous visitor on a portal page to the portal sign-in", async () => {
    const res = await visit(clientHost, "/portal/loans", null)
    expect(res.status).toBe(307)
    expect(new URL(res.headers.get("location")!).pathname).toBe("/portal/login")
  })

  it("keeps the client-host API allow-list: portal and shared APIs through, staff APIs 404", async () => {
    expect((await visit(clientHost, "/api/portal/loans", CLIENT)).status).toBe(200)
    expect((await visit(clientHost, "/api/applications/app-1/signing-packet", CLIENT)).status).toBe(200)
    expect((await visit(clientHost, "/api/health", null)).status).toBe(200)
    expect((await visit(clientHost, "/api/settings/users", STAFF)).status).toBe(404)
  })
})

// A dynamic segment takes any value, so an image suffix says nothing about the
// route behind it: the client host's audience gate has to run for these too, for
// every method. Only a read of a file that really is in public/ skips the proxy.
describe("image-suffixed paths on the client host (APP_MODE=client)", () => {
  describe.each(SESSIONS)("with %s", (_label, session) => {
    it.each(["/clients/x.png", "/loans/x.jpg", "/crm/leads/x.svg", "/inbox/x.webp", "/api/clients/x.png", "/api/settings/x.ico"])(
      "404s a GET of %s",
      async (url) => {
        expect((await visit(clientHost, url, session)).status, url).toBe(404)
      },
    )

    it.each(["POST", "PUT", "PATCH", "DELETE"])("404s a %s to the staff route /crm/leads/x.png (a server action)", async (method) => {
      expect((await visit(clientHost, "/crm/leads/x.png", session, "localhost", method)).status).toBe(404)
      expect((await visit(clientHost, "/api/clients/x.png", session, "localhost", method)).status).toBe(404)
    })
  })

  it("still answers a read of a real file in public/ without a session", async () => {
    const res = await visit(clientHost, "/file.svg", null)
    expect(res.status).toBe(200)
    expect(res.headers.get("x-middleware-next")).toBe("1")
  })

  it("the staff host and a single host run the proxy for them too", async () => {
    expect((await visit(staffHost, "/clients/x.png", null)).status).toBe(307)
    expect((await visit(singleHost, "/clients/x.png", null)).status).toBe(307)
  })
})

// /api/auth/* is public on every host, but only NextAuth's own endpoints (and the
// stale-session loop-breaker) belong on the client host: the app's staff
// forgot/reset-password handlers sit under the same prefix.
describe("/api/auth on the client host (APP_MODE=client)", () => {
  const NEXTAUTH = ["session", "csrf", "providers", "signin", "signin/credentials", "signout", "callback/credentials", "error", "expired"]
  const AUTH_ROUTES = walk(path.join(APP_DIR, "api", "auth"))
    .filter((f) => path.basename(f) === "route.ts")
    .map((f) => path.relative(path.join(APP_DIR, "api", "auth"), path.dirname(f)).split(path.sep)[0])
    .filter((seg) => seg !== "[...nextauth]" && seg !== "expired")

  it("finds the staff auth routes it checks", () => {
    expect(AUTH_ROUTES).toEqual(expect.arrayContaining(["forgot-password", "reset-password"]))
  })

  it.each(AUTH_ROUTES)("404s the app's own /api/auth/%s for every caller and method", async (name) => {
    for (const session of [STAFF, CLIENT, null]) {
      for (const method of ["GET", "POST"]) {
        const res = await visit(clientHost, `/api/auth/${name}`, session, "localhost", method)
        expect(res.status, `${method} ${name}`).toBe(404)
      }
    }
  })

  it.each(NEXTAUTH)("still serves NextAuth's /api/auth/%s", async (name) => {
    for (const method of ["GET", "POST"]) {
      const res = await visit(clientHost, `/api/auth/${name}`, null, "localhost", method)
      expect(res.status, `${method} ${name}`).toBe(200)
      expect(res.headers.get("x-middleware-next")).toBe("1")
    }
  })

  it("404s an unknown /api/auth path", async () => {
    expect((await visit(clientHost, "/api/auth/anything-else", null)).status).toBe(404)
    expect((await visit(clientHost, "/api/authx", null)).status).toBe(404)
  })

  it("the staff host and a single host still serve the staff forgot/reset-password", async () => {
    for (const host of [staffHost, singleHost]) {
      for (const name of ["forgot-password", "reset-password"]) {
        expect((await visit(host, `/api/auth/${name}`, null, "localhost", "POST")).status, name).toBe(200)
      }
    }
  })
})

describe("the other hosts are unchanged", () => {
  it("a single host (APP_MODE=all) still serves staff pages", async () => {
    for (const url of ["/inbox", "/contacts", "/learn", "/dashboard"]) {
      expect((await visit(singleHost, url, STAFF)).status, url).toBe(200)
    }
  })

  it("the staff host still serves staff pages and 404s the portal", async () => {
    for (const url of ["/inbox", "/contacts", "/learn", "/login"]) {
      expect((await visit(staffHost, url, STAFF)).status, url).not.toBe(404)
    }
    expect((await visit(staffHost, "/portal/loans", CLIENT)).status).toBe(404)
    expect((await visit(staffHost, "/portal/login", null)).status).toBe(404)
  })
})
