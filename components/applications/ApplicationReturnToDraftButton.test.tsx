import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ApplicationReturnToDraftButton } from "./ApplicationReturnToDraftButton"

const { refresh, push } = vi.hoisted(() => ({
  refresh: vi.fn(),
  push: vi.fn(),
}))

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh, push }),
}))

const actEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean
}

describe("ApplicationReturnToDraftButton", () => {
  beforeEach(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    refresh.mockReset()
    push.mockReset()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    delete actEnvironment.IS_REACT_ACT_ENVIRONMENT
  })

  it("requires an audit reason before returning the same application to draft", async () => {
    let renderer!: ReactTestRenderer
    await act(async () => {
      renderer = create(
        <ApplicationReturnToDraftButton applicationId="application-1" />,
      )
    })
    await act(async () => {
      renderer.root.findByType("button").props.onClick()
    })

    const confirmButton = renderer.root.findAllByType("button").find((button) =>
      Array.isArray(button.props.children) &&
      button.props.children.includes("Confirm and edit amount")
    )
    expect(confirmButton?.props.disabled).toBe(true)
    expect(JSON.stringify(renderer.toJSON())).toContain(
      "Give an audit reason",
    )
    await act(async () => renderer.unmount())
  })

  it("names the amendment job on the collapsed control", async () => {
    let renderer!: ReactTestRenderer
    await act(async () => {
      renderer = create(
        <ApplicationReturnToDraftButton applicationId="application-1" />,
      )
    })
    // The officer is hunting for a way to reduce the amount. "Return to Draft"
    // did not read as that, which is why the capability went unfound.
    expect(JSON.stringify(renderer.toJSON())).toContain("Amend loan amount")
    await act(async () => renderer.unmount())
  })

  it("explains that the fresh PASQ and agreement are prepared together after reapproval", async () => {
    let renderer!: ReactTestRenderer
    await act(async () => {
      renderer = create(
        <ApplicationReturnToDraftButton applicationId="application-1" />,
      )
    })
    await act(async () => {
      renderer.root.findByType("button").props.onClick()
    })

    // Amending the principal invalidates the old quote by design
    // (lib/insurance/credit-life-election.server.ts re-derives the premium from
    // principalCents). Staff must know that the replacement quote and agreement
    // are prepared together after approval, not wait for a portal
    // acknowledgement during review.
    const rendered = JSON.stringify(renderer.toJSON())
    expect(rendered).toContain("After reapproval")
    expect(rendered).toContain(
      "prepare a fresh PASQ and credit agreement together",
    )
    expect(rendered).toContain("sign in one sitting")
    expect(rendered).not.toContain("acknowledge")
    await act(async () => renderer.unmount())
  })

  it("posts the audited return and opens the wizard at the loan-params step", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init: { method: string; body: FormData }) => ({
        ok: true,
        json: async () => ({ ok: true, status: "DRAFT" }),
      }),
    )
    vi.stubGlobal("fetch", fetchMock)

    let renderer!: ReactTestRenderer
    await act(async () => {
      renderer = create(
        <ApplicationReturnToDraftButton applicationId="application-1" />,
      )
    })
    await act(async () => {
      renderer.root.findByType("button").props.onClick()
    })
    await act(async () => {
      renderer.root.findByType("textarea").props.onChange({
        target: { value: "Recapture missing consumer election" },
      })
    })
    const confirmButton = renderer.root.findAllByType("button").find((button) =>
      Array.isArray(button.props.children) &&
      button.props.children.includes("Confirm and edit amount")
    )
    expect(confirmButton?.props.disabled).toBe(false)

    await act(async () => {
      await confirmButton!.props.onClick()
    })

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("/api/applications/application-1/decide")
    expect(init.method).toBe("POST")
    expect(init.body.get("action")).toBe("return_to_draft")
    expect(init.body.get("reason")).toBe(
      "Recapture missing consumer election",
    )
    // The amount is only editable in the wizard, so the officer must land
    // there — step 2 is Loan Parameters. A bare refresh left them stranded on
    // the case file with no visible amount field.
    expect(push).toHaveBeenCalledWith(
      "/applications/new?id=application-1&step=2",
    )
    await act(async () => renderer.unmount())
  })

  it("keeps the officer on the case file when the amendment is refused", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      json: async () => ({ error: "Only an application under review can be returned to draft" }),
    }))
    vi.stubGlobal("fetch", fetchMock)

    let renderer!: ReactTestRenderer
    await act(async () => {
      renderer = create(
        <ApplicationReturnToDraftButton applicationId="application-1" />,
      )
    })
    await act(async () => {
      renderer.root.findByType("button").props.onClick()
    })
    await act(async () => {
      renderer.root.findByType("textarea").props.onChange({
        target: { value: "Reduce principal to R1 000 on risk" },
      })
    })
    const confirmButton = renderer.root.findAllByType("button").find((button) =>
      Array.isArray(button.props.children) &&
      button.props.children.includes("Confirm and edit amount")
    )
    await act(async () => {
      await confirmButton!.props.onClick()
    })

    // Navigating away on a refusal would strand the officer in a wizard for an
    // application that never left review, hiding the reason it was refused.
    expect(push).not.toHaveBeenCalled()
    expect(JSON.stringify(renderer.toJSON())).toContain(
      "Only an application under review can be returned to draft",
    )
    await act(async () => renderer.unmount())
  })
})
