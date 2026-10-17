import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { OperatorSignOut } from "./OperatorSignOut"

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
const button = () => tree!.root.findByType("button")

describe("operator sign-out stays on the console host", () => {
  it("waits for sign-out and ignores a returned canonical staff URL", async () => {
    let finish!: (value: { url: string }) => void
    signOut.mockReturnValue(new Promise(resolve => { finish = resolve }))
    await act(async () => { tree = create(<OperatorSignOut />) })
    await act(async () => { void button().props.onClick() })
    expect(signOut).toHaveBeenCalledWith({ redirect: false })
    expect(button().props.disabled).toBe(true)
    expect(assign).not.toHaveBeenCalled()
    await act(async () => { finish({ url: "https://staff.invalid/operator/login" }) })
    expect(assign).toHaveBeenCalledExactlyOnceWith("/operator/login")
  })

  it("shows a transport refusal, does not navigate, and lets the operator retry", async () => {
    signOut.mockRejectedValueOnce(new Error("synthetic transport failure"))
    await act(async () => { tree = create(<OperatorSignOut />) })
    await act(async () => { await button().props.onClick() })
    expect(assign).not.toHaveBeenCalled()
    expect(button().props.disabled).toBe(false)
    expect(tree!.root.findByProps({ role: "alert" }).children.join("")).toContain("Try again")
    signOut.mockResolvedValueOnce({ url: "https://staff.invalid/" })
    await act(async () => { await button().props.onClick() })
    expect(signOut).toHaveBeenCalledTimes(2)
    expect(assign).toHaveBeenCalledExactlyOnceWith("/operator/login")
  })

  it("sends a single sign-out while the request is pending", async () => {
    let finish!: (value: { url: string }) => void
    signOut.mockReturnValue(new Promise(resolve => { finish = resolve }))
    await act(async () => { tree = create(<OperatorSignOut />) })
    const click = button().props.onClick
    await act(async () => { void click(); void click() })
    expect(signOut).toHaveBeenCalledTimes(1)
    expect(assign).not.toHaveBeenCalled()
    await act(async () => { finish({ url: "https://staff.invalid/" }) })
    expect(assign).toHaveBeenCalledExactlyOnceWith("/operator/login")
  })
})
