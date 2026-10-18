import { createHash } from "node:crypto"
import { describe, expect, it, vi } from "vitest"
import type { Persona } from "../personas"
import type { SimClient } from "../sim/api"

vi.mock("../sim/env", async (orig) => ({ ...(await orig<typeof import("../sim/env")>()), log: () => undefined }))

import { disburse, signAgreement, signDebitMandate } from "./signing"
import type { OriginationContext } from "./context"

const PDF = new TextEncoder().encode("%PDF-1.4 synthetic agreement")
const PDF_SHA = createHash("sha256").update(PDF).digest("hex")
const persona = { id: "p1", firstName: "Test", lastName: "Persona", bank: { bankCode: "X", branchCode: "1", accountNumber: "2", accountType: "CHEQUE" } } as unknown as Persona

/** A portal SimClient fake recording POSTs; the signing-otp endpoints answer like a demo stack. */
function fakePortal(issued: Record<string, unknown> = { challengeId: "otp-1", demoCode: "123456" }) {
  const posts: { path: string; body: unknown }[] = []
  const portal = {
    get: async () => ({ status: 200, headers: new Headers({ "content-type": "application/pdf" }), json: null, text: "", bytes: PDF }),
    post: async (path: string, body: unknown) => {
      posts.push({ path, body })
      const json = path === "/api/signing-otp" ? issued : path.endsWith("/debit-mandate") ? { draftDocumentSha256: "d".repeat(64) } : {}
      return { status: 200, headers: new Headers(), json, text: JSON.stringify(json), bytes: new Uint8Array() }
    },
  }
  return { portal: portal as unknown as SimClient, posts }
}

describe("demo signing scenario: the borrower verifies a signing code before each portal signature", () => {
  it("requests a code for the agreement bytes it opened, verifies the revealed code, and signs with it", async () => {
    const { portal, posts } = fakePortal()
    await signAgreement(portal, persona, "app-1", "p".repeat(64))
    expect(posts.map((p) => p.path)).toEqual([
      "/api/signing-otp", "/api/signing-otp/otp-1/verify", "/api/applications/app-1/agreement/sign",
    ])
    expect(posts[0].body).toEqual({ purpose: "AGREEMENT", subjectId: "app-1", documentSha256: PDF_SHA, channel: "EMAIL" })
    expect(posts[1].body).toEqual({ code: "123456" })
    expect(posts[2].body).toEqual(expect.objectContaining({ signingOtpChallengeId: "otp-1", agreementDocumentSha256: PDF_SHA }))
  })

  it("explicitly accepts all five current declarations only for the fresh agreement it signs", async () => {
    const { portal, posts } = fakePortal()
    await signAgreement(portal, persona, "app-1", "p".repeat(64))
    expect(posts[2].body).toEqual({
      method: "portal",
      signature: "Test Persona",
      agreementDocumentSha256: PDF_SHA,
      pasqDocumentSha256: "p".repeat(64),
      signingOtpChallengeId: "otp-1",
      declarations: {
        version: "portal-agreement-declarations-v1",
        setSha256: "94948b549e9415944b73909f0dce298c5b304e8ed4f832de4e14787e5452cfd7",
        acceptedIds: ["pasq_read", "schedule_read", "settlement_right", "terms_accepted", "information_true"],
      },
    })
    expect(posts.slice(0, 2).every(({ body }) => !("declarations" in (body as object)))).toBe(true)
  })

  it("binds the mandate code to the prepared draft digest", async () => {
    const { portal, posts } = fakePortal()
    await signDebitMandate(portal, persona, "app-1")
    expect(posts[1].body).toEqual({ purpose: "DEBIT_MANDATE", subjectId: "app-1", documentSha256: "d".repeat(64), channel: "EMAIL" })
    expect(posts[3].body).toEqual(expect.objectContaining({ signingOtpChallengeId: "otp-1" }))
  })

  it("fails loudly rather than signing without a code when the stack does not reveal it", async () => {
    const { portal, posts } = fakePortal({ challengeId: "otp-1" })
    await expect(signAgreement(portal, persona, "app-1", "p".repeat(64))).rejects.toThrow(/not revealed/)
    expect(posts.map((p) => p.path)).not.toContain("/api/applications/app-1/agreement/sign")
  })
})

describe("demo signing scenario: payout", () => {
  /** A signed-in staff SimClient fake recording the paths it POSTs. */
  function staffClient(posted: string[], who: string) {
    return {
      user: { role: who },
      session: async () => true,
      post: async (path: string) => {
        posted.push(`${who} ${path}`)
        const json = { loanId: "loan-1", loanRef: "LN-1" }
        return { status: 200, headers: new Headers(), json, text: JSON.stringify(json), bytes: new Uint8Array() }
      },
    } as unknown as SimClient
  }
  const creds = { email: "x@example.invalid", password: "p", totpSecret: "s" }

  it("pays out as the disburser, never the admin who approved, when the context has one", async () => {
    const posted: string[] = []
    const ctx = {
      officer: staffClient(posted, "officer"),
      admin: staffClient(posted, "admin"),
      disburser: { client: staffClient(posted, "loan-admin"), creds },
      creds: { admin: creds, officer: creds, portalPassword: "p" },
    } as unknown as OriginationContext
    expect(await disburse(ctx, "app-1")).toEqual({ loanId: "loan-1", loanRef: "LN-1" })
    expect(posted).toEqual(["loan-admin /api/applications/app-1/disburse"])
  })

  it("falls back to the admin without one", async () => {
    const posted: string[] = []
    const ctx = {
      officer: staffClient(posted, "officer"),
      admin: staffClient(posted, "admin"),
      creds: { admin: creds, officer: creds, portalPassword: "p" },
    } as unknown as OriginationContext
    await disburse(ctx, "app-1")
    expect(posted).toEqual(["admin /api/applications/app-1/disburse"])
  })
})

