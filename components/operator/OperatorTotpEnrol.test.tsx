import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { OperatorTotpEnrol } from "./OperatorTotpEnrol"

const { signOut, assign } = vi.hoisted(() => ({ signOut: vi.fn(), assign: vi.fn() }))
vi.mock("next-auth/react", () => ({ signOut }))
const g = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
let tree: ReactTestRenderer | undefined
beforeEach(() => {
  g.IS_REACT_ACT_ENVIRONMENT = true
  signOut.mockReset(); assign.mockReset()
  vi.stubGlobal("window", { location: { assign } })
})
afterEach(async () => {
  await act(async () => { tree?.unmount() }); tree = undefined
  vi.unstubAllGlobals(); delete g.IS_REACT_ACT_ENVIRONMENT
})

it("after successful enrolment waits for sign-out then returns to the same-host operator login", async () => {
  const fetcher = vi.fn()
    .mockResolvedValueOnce({ ok: true, json: async () => ({ secret: "SYNTHETIC-ONLY", otpauth: "otpauth://totp/synthetic" }) })
    .mockResolvedValueOnce({ ok: true })
  vi.stubGlobal("fetch", fetcher)
  await act(async () => { tree = create(<OperatorTotpEnrol email="operator@synthetic.invalid" />) })
  await act(async () => { await tree!.root.findByType("button").props.onClick() })
  await act(async () => { tree!.root.findByType("input").props.onChange({ target: { value: "123456" } }) })
  await act(async () => { await tree!.root.findByType("button").props.onClick() })
  expect(fetcher).toHaveBeenLastCalledWith("/api/operator/totp", expect.objectContaining({ method: "POST" }))
  expect(tree!.root.findByType("button").props.children).toBe("Sign in again")
  let finish!: (value: { url: string }) => void
  signOut.mockReturnValue(new Promise(resolve => { finish = resolve }))
  await act(async () => { void tree!.root.findByType("button").props.onClick() })
  expect(signOut).toHaveBeenCalledWith({ redirect: false })
  expect(assign).not.toHaveBeenCalled()
  await act(async () => { finish({ url: "http://staff.invalid/operator/login" }) })
  expect(assign).toHaveBeenCalledExactlyOnceWith("/operator/login")
})
