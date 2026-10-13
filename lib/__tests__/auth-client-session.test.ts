import { createHash } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

interface CapturedConfig {
  callbacks: { jwt: (args: Record<string, unknown>) => Promise<unknown> }
  providers: Array<{ authorize: (credentials: Record<string, string>, request: Request) => Promise<unknown> }>
}

const { mocks, captured } = vi.hoisted(() => ({
  mocks: {
    clientFindFirst: vi.fn(),
    clientFindUnique: vi.fn(),
    userFindUnique: vi.fn(),
    failedAttemptCreate: vi.fn(),
    compare: vi.fn(),
  },
  captured: { config: undefined as undefined | CapturedConfig },
}))

// next-auth is replaced by a recorder so the real jwt callback and authorize()
// from lib/auth.ts can be called directly.
vi.mock("next-auth", () => ({
  default: vi.fn((config: CapturedConfig) => {
    captured.config = config
    return { handlers: {}, auth: vi.fn(), signIn: vi.fn(), signOut: vi.fn() }
  }),
  CredentialsSignin: class {},
}))
vi.mock("next-auth/providers/credentials", () => ({ default: (config: unknown) => config }))
vi.mock("@/lib/tenant-scope", () => ({ withoutTenantScope: <T,>(fn: () => Promise<T>) => fn() }))
vi.mock("bcryptjs", () => ({ default: { compare: mocks.compare, hashSync: () => "dummy-hash" } }))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findUnique: mocks.userFindUnique, update: vi.fn(), updateMany: vi.fn() },
    client: { findFirst: mocks.clientFindFirst, findUnique: mocks.clientFindUnique },
    failedLoginAttempt: { create: mocks.failedAttemptCreate },
    loginLog: { create: vi.fn() },
  },
}))

import "../auth"
import { clientCredentialStamp } from "../client-session"

vi.stubEnv("AUTH_SECRET", "test-secret-one")

const jwt = (args: Record<string, unknown>) => captured.config!.callbacks.jwt(args)
const authorize = (credentials: Record<string, string>) =>
  captured.config!.providers[0].authorize(
    credentials,
    new Request("http://localhost/api/auth/callback/credentials", { headers: { "x-forwarded-for": "203.0.113.9" } }),
  )

const HASH = "$2a$12$syntheticbcrypthashforthetestsuiteonly000000000000000000"
const clientToken = (over: Record<string, unknown> = {}) => ({
  id: "c1",
  role: "CLIENT",
  tenantId: "t1",
  credentialStamp: clientCredentialStamp(HASH),
  ...over,
})

beforeEach(() => {
  vi.stubEnv("AUTH_SECRET", "test-secret-one")
  vi.stubEnv("APP_MODE", "")
  mocks.clientFindFirst.mockReset()
  mocks.clientFindUnique.mockReset()
  mocks.userFindUnique.mockReset()
  mocks.failedAttemptCreate.mockReset().mockResolvedValue({})
  mocks.compare.mockReset().mockResolvedValue(true)
})
afterEach(() => vi.unstubAllEnvs())

describe("jwt callback: client sessions are revalidated on refresh", () => {
  it("ends the session when the Client row no longer exists", async () => {
    mocks.clientFindFirst.mockResolvedValue(null)
    expect(await jwt({ token: clientToken() })).toBeNull()
  })

  it("looks the client up by id AND tenantId", async () => {
    mocks.clientFindFirst.mockResolvedValue({ portalPassword: HASH })
    await jwt({ token: clientToken() })
    expect(mocks.clientFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "c1", tenantId: "t1" } }),
    )
  })

  it("ends the session when portal access is disabled (no portal password)", async () => {
    mocks.clientFindFirst.mockResolvedValue({ portalPassword: null })
    expect(await jwt({ token: clientToken() })).toBeNull()
  })

  // The stamp of the old hash never matches a cleared password, so the test
  // above would pass without the explicit check. A token stamped as if the
  // cleared value were a credential ("null" is what an unguarded stamp of it
  // would hash) only ends here because the cleared password is refused outright.
  it("refuses a cleared portal password before any stamp comparison", async () => {
    mocks.clientFindFirst.mockResolvedValue({ portalPassword: null })
    expect(await jwt({ token: clientToken({ credentialStamp: clientCredentialStamp("null") }) })).toBeNull()
  })

  it("ends the session after a password reset or change", async () => {
    mocks.clientFindFirst.mockResolvedValue({ portalPassword: "$2a$12$a-newer-hash-after-the-reset" })
    expect(await jwt({ token: clientToken() })).toBeNull()
  })

  it("ends the session for a token issued before the credential stamp existed", async () => {
    mocks.clientFindFirst.mockResolvedValue({ portalPassword: HASH })
    const { credentialStamp: _drop, ...legacy } = clientToken()
    expect(await jwt({ token: legacy })).toBeNull()
  })

  it("keeps a session whose credential is unchanged", async () => {
    mocks.clientFindFirst.mockResolvedValue({ portalPassword: HASH })
    const token = clientToken()
    expect(await jwt({ token })).toEqual(token)
  })

  it("ends the session for a client token with no tenant", async () => {
    expect(await jwt({ token: clientToken({ tenantId: undefined }) })).toBeNull()
    expect(mocks.clientFindFirst).not.toHaveBeenCalled()
  })

  it("retains the token on a transient DB error, as the staff path does", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.clientFindFirst.mockRejectedValue(new Error("connection reset"))
    const token = clientToken()
    expect(await jwt({ token })).toEqual(token)
  })

  it("stamps the token at sign-in from the user authorize() returned", async () => {
    const out = await jwt({
      token: {},
      user: { id: "c1", role: "CLIENT", tenantId: "t1", credentialStamp: "stamp-1" },
    })
    expect(out).toMatchObject({ id: "c1", role: "CLIENT", tenantId: "t1", credentialStamp: "stamp-1" })
  })

  it("does not touch the client lookup for staff tokens", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.userFindUnique.mockResolvedValue({ active: true, role: "LOAN_ADMIN", tenantId: "t1", tokenVersion: 0 })
    await jwt({ token: { id: "u1", role: "LOAN_ADMIN", tenantId: "t1", tokenVersion: 0 } })
    expect(mocks.clientFindFirst).not.toHaveBeenCalled()
  })
})

describe("clientCredentialStamp", () => {
  it("is keyed: it is not a bare digest of the hash and does not contain it", () => {
    const stamp = clientCredentialStamp(HASH)
    expect(stamp).toMatch(/^[0-9a-f]{32}$/)
    expect(stamp).not.toContain(HASH)
    expect(stamp).not.toBe(createHash("sha256").update(HASH).digest("hex").slice(0, 32))
  })

  it("changes with AUTH_SECRET and with the hash", () => {
    const a = clientCredentialStamp(HASH)
    expect(clientCredentialStamp(HASH + "x")).not.toBe(a)
    vi.stubEnv("AUTH_SECRET", "test-secret-two")
    expect(clientCredentialStamp(HASH)).not.toBe(a)
  })

  it("refuses to stamp without a secret", () => {
    vi.stubEnv("AUTH_SECRET", "")
    vi.stubEnv("NEXTAUTH_SECRET", "")
    expect(() => clientCredentialStamp(HASH)).toThrow(/AUTH_SECRET/)
  })
})

describe("authorize(): sign-in audience follows APP_MODE", () => {
  const clientRow = {
    id: "c1", email: "client@example.test", firstName: "Test", lastName: "Client",
    tenantId: "t1", portalPassword: HASH,
  }
  const asClient = (email: string) => ({ email, password: "pw", loginType: "client" })
  const asStaff = (email: string) => ({ email, password: "pw", loginType: "staff" })

  it("a client sign-in carries the credential stamp for the jwt callback", async () => {
    mocks.clientFindUnique.mockResolvedValue(clientRow)
    const user = await authorize(asClient("stamp@example.test"))
    expect(user).toMatchObject({ id: "c1", role: "CLIENT", tenantId: "t1", credentialStamp: clientCredentialStamp(HASH) })
  })

  it("APP_MODE=client refuses loginType=staff before any staff lookup", async () => {
    vi.stubEnv("APP_MODE", "client")
    mocks.userFindUnique.mockResolvedValue({ id: "u1", email: "a1@example.test", password: HASH, active: true, tenantId: "t1" })
    await expect(authorize(asStaff("a1@example.test"))).rejects.toMatchObject({ code: "wrong_audience" })
    expect(mocks.userFindUnique).not.toHaveBeenCalled()
    expect(mocks.failedAttemptCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ reason: "wrong_audience" }) }),
    )
  })

  it("APP_MODE=staff refuses loginType=client before any client lookup", async () => {
    vi.stubEnv("APP_MODE", "staff")
    mocks.clientFindUnique.mockResolvedValue(clientRow)
    await expect(authorize(asClient("a2@example.test"))).rejects.toMatchObject({ code: "wrong_audience" })
    expect(mocks.clientFindUnique).not.toHaveBeenCalled()
  })

  it("APP_MODE=client still signs a client in", async () => {
    vi.stubEnv("APP_MODE", "client")
    mocks.clientFindUnique.mockResolvedValue(clientRow)
    expect(await authorize(asClient("a3@example.test"))).toMatchObject({ role: "CLIENT" })
  })

  it("APP_MODE=staff still looks a staff user up", async () => {
    vi.stubEnv("APP_MODE", "staff")
    mocks.userFindUnique.mockResolvedValue(null)
    await expect(authorize(asStaff("a4@example.test"))).rejects.toMatchObject({ code: "wrong_audience" })
    expect(mocks.userFindUnique).toHaveBeenCalled()
  })

  it("APP_MODE unset (single host) allows both audiences", async () => {
    mocks.userFindUnique.mockResolvedValue(null)
    mocks.clientFindUnique.mockResolvedValue(clientRow)
    await authorize(asStaff("a5@example.test")).catch(() => {})
    expect(mocks.userFindUnique).toHaveBeenCalled()
    expect(await authorize(asClient("a6@example.test"))).toMatchObject({ role: "CLIENT" })
  })
})
