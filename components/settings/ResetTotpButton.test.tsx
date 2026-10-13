import { act, create } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { SettingsUser } from "@/lib/settings-users"

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock("@/lib/toast", () => ({ toast }))

import { ResetTotpButton } from "./ResetTotpButton"

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const user: SettingsUser = { id: "u2", name: "Sam Dlamini", email: "sam@acme-lending.example", role: "CREDIT_OFFICER", active: true, createdAt: "2026-01-01", totpEnabled: true }

const confirmMock = vi.fn()
const fetchMock = vi.fn()
const onDone = vi.fn()

async function click(props: { staffTotpRequired: boolean; user?: SettingsUser }) {
  let renderer!: ReturnType<typeof create>
  await act(async () => { renderer = create(<ResetTotpButton user={props.user ?? user} staffTotpRequired={props.staffTotpRequired} onDone={onDone} />) })
  await act(async () => { renderer.root.findByType("button").props.onClick() })
  return renderer
}

beforeEach(() => {
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  vi.clearAllMocks()
  vi.stubGlobal("confirm", confirmMock)
  vi.stubGlobal("fetch", fetchMock)
  confirmMock.mockReturnValue(true)
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }))
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete actEnvironment.IS_REACT_ACT_ENVIRONMENT
})

describe("ResetTotpButton", () => {
  it("is titled Reset 2FA", async () => {
    let renderer!: ReturnType<typeof create>
    await act(async () => { renderer = create(<ResetTotpButton user={user} staffTotpRequired onDone={onDone} />) })
    expect(renderer.root.findByType("button").props.title).toBe("Reset 2FA")
  })

  it("asks first, with the re-enrolment wording while the lender requires 2FA, and calls nothing if declined", async () => {
    confirmMock.mockReturnValue(false)
    await click({ staffTotpRequired: true })
    expect(confirmMock).toHaveBeenCalledWith("Reset two-factor authentication for Sam Dlamini? They will be signed out and must set it up again at their next sign-in.")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("uses the wording that promises no re-enrolment while the setting is off", async () => {
    await click({ staffTotpRequired: false })
    expect(confirmMock).toHaveBeenCalledWith("Reset two-factor authentication for Sam Dlamini? They will be signed out. Two-factor authentication will be off until they set it up again.")
  })

  it("calls DELETE on the user's totp route, then reports success and refreshes", async () => {
    await click({ staffTotpRequired: true })
    expect(fetchMock).toHaveBeenCalledWith("/api/settings/users/u2/totp", { method: "DELETE" })
    expect(toast.success).toHaveBeenCalledWith("Two-factor authentication reset for Sam Dlamini.")
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it("names the user by email when there is no name", async () => {
    await click({ staffTotpRequired: true, user: { ...user, name: null } })
    expect(toast.success).toHaveBeenCalledWith("Two-factor authentication reset for sam@acme-lending.example.")
  })

  it("shows the server's refusal and does not refresh", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: "You cannot modify a user whose role is the same as your own" }), { status: 403 }))
    await click({ staffTotpRequired: true })
    expect(toast.error).toHaveBeenCalledWith("You cannot modify a user whose role is the same as your own")
    expect(toast.success).not.toHaveBeenCalled()
    expect(onDone).not.toHaveBeenCalled()
  })
})
