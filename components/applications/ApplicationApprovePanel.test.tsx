import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ApplicationApprovePanel } from "./ApplicationApprovePanel"

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }))

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}))

const actEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean
}

function response(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }
}

function childText(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value)
  if (Array.isArray(value)) return value.map(childText).join("")
  if (value && typeof value === "object" && "props" in value) {
    return childText((value as { props?: { children?: unknown } }).props?.children)
  }
  return ""
}

function button(renderer: ReactTestRenderer, label: string) {
  const candidate = renderer.root.findAllByType("button").find((node) =>
    childText(node.props.children).includes(label),
  )
  if (!candidate) throw new Error(`Button not found: ${label}`)
  return candidate
}

function renderedText(renderer: ReactTestRenderer): string {
  return JSON.stringify(renderer.toJSON())
}

describe("ApplicationApprovePanel bureau override feedback", () => {
  beforeEach(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    refresh.mockReset()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    delete actEnvironment.IS_REACT_ACT_ENVIRONMENT
  })

  it("requires a repayment method and submits the selected EFT decision", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(response(200, { ok: true }))
    vi.stubGlobal("fetch", fetchMock)

    let renderer!: ReactTestRenderer
    await act(async () => {
      renderer = create(
        <ApplicationApprovePanel applicationId="application-1" canApprove openChecks={0} />,
      )
    })

    expect(button(renderer, "Approve").props.disabled).toBe(true)

    const eft = renderer.root.findAllByType("input").find(
      (node) => node.props.type === "radio" && node.props.value === "EFT",
    )
    if (!eft) throw new Error("EFT repayment option not found")
    await act(async () => {
      eft.props.onChange()
    })
    expect(button(renderer, "Approve").props.disabled).toBe(false)

    await act(async () => {
      await button(renderer, "Approve").props.onClick()
    })

    const body = fetchMock.mock.calls[0][1]?.body
    expect(body).toBeInstanceOf(FormData)
    expect((body as FormData).get("repaymentMethod")).toBe("EFT")
    expect(refresh).toHaveBeenCalledOnce()

    await act(async () => renderer.unmount())
  })

  it("keeps the override reason and visibly renders a rejected reason error", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(422, {
        error: "Bureau enquiry required: cannot approve without a current credit bureau check.",
        requiresOverride: true,
        bureauMissing: true,
      }))
      .mockResolvedValueOnce(response(400, {
        error: "Bureau override reason must be at least 10 characters.",
        bureauOverrideValidation: "reason_too_short",
      }))
    vi.stubGlobal("fetch", fetchMock)

    let renderer!: ReactTestRenderer
    await act(async () => {
      renderer = create(
        <ApplicationApprovePanel applicationId="application-1" canApprove openChecks={0} />,
      )
    })

    await act(async () => {
      await button(renderer, "Approve").props.onClick()
    })
    expect(renderedText(renderer)).toContain("Bureau enquiry missing")
    expect(childText(renderer.root.findByProps({ role: "status" }).props.children)).toContain(
      "Bureau enquiry missing",
    )

    const textarea = renderer.root.findByType("textarea")
    await act(async () => {
      textarea.props.onChange({ target: { value: "short" } })
    })
    await act(async () => {
      await button(renderer, "Confirm Override").props.onClick()
    })

    const alert = renderer.root.findByProps({ role: "alert" })
    expect(childText(alert.props.children)).toBe(
      "Bureau override reason must be at least 10 characters.",
    )
    expect(renderer.root.findByType("textarea").props.value).toBe("short")
    expect(renderedText(renderer)).toContain("override required")
    expect(refresh).not.toHaveBeenCalled()

    const secondBody = fetchMock.mock.calls[1]?.[1]?.body as FormData
    expect(secondBody.get("action")).toBe("approve")
    expect(secondBody.get("bureauOverrideReason")).toBe("short")

    await act(async () => renderer.unmount())
  })

  it.each([
    {
      label: "KYC",
      status: 422,
      body: {
        error: "KYC not complete.",
        kycStatus: "PENDING",
        missingDocs: ["ID_DOCUMENT"],
      },
      expected: "KYC incomplete (PENDING) - missing: ID DOCUMENT",
    },
    {
      label: "ID copy awaiting verification",
      status: 422,
      body: {
        error: "The client's ID copy must be verified before approval; the selfie already matched it.",
        kycStatus: "PENDING",
        missingDocs: ["ID_COPY"],
        idCopyAwaitingVerification: true,
      },
      expected: "The client's ID copy must be verified before approval; the selfie already matched it.",
    },
    {
      label: "immutable affordability",
      status: 422,
      body: {
        error: "The approved affordability evidence changed.",
        affordabilitySnapshot: "submission_changed",
      },
      expected: "The approved affordability evidence changed.",
    },
    {
      label: "non-overridable affordability",
      status: 422,
      body: {
        error: "Affordability assessment did not pass.",
        requiresOverride: false,
      },
      expected: "Affordability assessment did not pass.",
    },
    {
      label: "deceased bureau",
      status: 422,
      body: {
        error: "Approval blocked: The bureau reports the consumer as deceased. This cannot be overridden.",
        deceasedBlock: true,
        requiresOverride: false,
      },
      expected: "Approval blocked: The bureau reports the consumer as deceased. This cannot be overridden.",
    },
    {
      label: "missing PASQ",
      status: 422,
      body: {
        error: "Approval requires a generated, client-acknowledged PASQ bound to exact pricing evidence.",
        missingComplianceEvidence: ["versioned PASQ"],
        pasqEvidence: "missing",
      },
      expected: "Approval requires a generated, client-acknowledged PASQ bound to exact pricing evidence.",
    },
    {
      label: "concurrent KYC change",
      status: 409,
      body: {
        error: "KYC evidence changed before the application could be approved; refresh and complete KYC again.",
        kycEvidence: "changed",
      },
      expected: "KYC evidence changed before the application could be approved; refresh and complete KYC again.",
    },
    {
      label: "application status change",
      status: 400,
      body: {
        error: "Application is not under review",
      },
      expected: "Application is not under review",
    },
    {
      label: "server failure",
      status: 500,
      body: {
        error: "Failed to process decision",
      },
      expected: "Failed to process decision",
    },
    {
      label: "malformed truthy override marker",
      status: 422,
      body: {
        error: "Malformed override response.",
        requiresOverride: "false",
      },
      expected: "Malformed override response.",
    },
    {
      label: "malformed KYC document list",
      status: 422,
      body: {
        error: "Malformed KYC response.",
        missingDocs: "ID_DOCUMENT",
      },
      expected: "Malformed KYC response.",
    },
    {
      label: "null response body",
      status: 422,
      body: null,
      expected: "An error occurred",
    },
  ])("visibly leaves override mode for a new $label blocker", async ({ status, body, expected }) => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(422, {
        error: "Bureau enquiry required: cannot approve without a current credit bureau check.",
        requiresOverride: true,
        bureauMissing: true,
      }))
      .mockResolvedValueOnce(response(status, body))
    vi.stubGlobal("fetch", fetchMock)

    let renderer!: ReactTestRenderer
    await act(async () => {
      renderer = create(
        <ApplicationApprovePanel applicationId="application-1" canApprove openChecks={0} />,
      )
    })

    await act(async () => {
      await button(renderer, "Approve").props.onClick()
    })
    const textarea = renderer.root.findByType("textarea")
    await act(async () => {
      textarea.props.onChange({
        target: { value: "Verified alternative affordability evidence" },
      })
    })
    await act(async () => {
      await button(renderer, "Confirm Override").props.onClick()
    })

    const alert = renderer.root.findByProps({ role: "alert" })
    expect(childText(alert.props.children)).toBe(expected)
    expect(renderedText(renderer)).not.toContain("override required")
    expect(refresh).not.toHaveBeenCalled()

    await act(async () => renderer.unmount())
  })

  it("exits override mode before refreshing after a successful approval", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(422, {
        error: "Bureau enquiry required: cannot approve without a current credit bureau check.",
        requiresOverride: true,
        bureauMissing: true,
      }))
      .mockResolvedValueOnce(response(200, { ok: true }))
    vi.stubGlobal("fetch", fetchMock)

    let renderer!: ReactTestRenderer
    await act(async () => {
      renderer = create(
        <ApplicationApprovePanel applicationId="application-1" canApprove openChecks={0} />,
      )
    })

    await act(async () => {
      await button(renderer, "Approve").props.onClick()
    })
    const textarea = renderer.root.findByType("textarea")
    await act(async () => {
      textarea.props.onChange({
        target: { value: "Verified alternative affordability evidence" },
      })
    })
    await act(async () => {
      await button(renderer, "Confirm Override").props.onClick()
    })

    expect(renderedText(renderer)).not.toContain("override required")
    expect(renderedText(renderer)).not.toContain("Confirm Override")
    expect(renderedText(renderer)).not.toContain("Decline")
    expect(childText(renderer.root.findByProps({ role: "status" }).props.children)).toBe(
      "Application updated. Refreshing...",
    )
    expect(refresh).toHaveBeenCalledOnce()

    await act(async () => renderer.unmount())
  })

  it("says so when the approval was one level of several, instead of claiming the application was updated", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response(200, { ok: true, status: "UNDER_REVIEW", approvalRecorded: true, level: 1, requiredLevels: 2, nextLevel: 2, nextLevelName: "Branch manager" })))
    let renderer!: ReactTestRenderer
    await act(async () => {
      renderer = create(<ApplicationApprovePanel applicationId="application-1" canApprove openChecks={0} />)
    })
    const eft = renderer.root.findAllByType("input").find((node) => node.props.type === "radio" && node.props.value === "EFT")
    if (!eft) throw new Error("EFT repayment option not found")
    await act(async () => {
      eft.props.onChange()
    })
    await act(async () => {
      await button(renderer, "Approve").props.onClick()
    })
    expect(childText(renderer.root.findByProps({ role: "status" }).props.children)).toBe(
      "Your approval is recorded as level 1 of 2. The application stays under review. Level 2 (Branch manager) approves next.",
    )
    expect(refresh).toHaveBeenCalledOnce()
    await act(async () => renderer.unmount())
  })

  it("uses action-neutral terminal feedback after a successful decline", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(response(200, { ok: true }))
    vi.stubGlobal("fetch", fetchMock)

    let renderer!: ReactTestRenderer
    await act(async () => {
      renderer = create(
        <ApplicationApprovePanel applicationId="application-1" canApprove openChecks={0} />,
      )
    })

    await act(async () => {
      button(renderer, "Decline").props.onClick()
    })
    await act(async () => {
      await button(renderer, "Confirm Decline").props.onClick()
    })

    expect(childText(renderer.root.findByProps({ role: "status" }).props.children)).toBe(
      "Application updated. Refreshing...",
    )
    expect(renderedText(renderer)).not.toContain("Approve")
    expect(renderedText(renderer)).not.toContain("Decline")
    expect(refresh).toHaveBeenCalledOnce()

    await act(async () => renderer.unmount())
  })

  it("keeps a failed decline visible and retryable without losing the reason", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(response(500, {
      error: "Failed to process decision",
    }))
    vi.stubGlobal("fetch", fetchMock)

    let renderer!: ReactTestRenderer
    await act(async () => {
      renderer = create(
        <ApplicationApprovePanel applicationId="application-1" canApprove openChecks={0} />,
      )
    })

    await act(async () => {
      button(renderer, "Decline").props.onClick()
    })
    const textarea = renderer.root.findByProps({ "aria-label": "Reason shown to the client" })
    await act(async () => {
      textarea.props.onChange({ target: { value: "Verified decline reason" } })
    })
    await act(async () => {
      renderer.root.findByType("select").props.onChange({ target: { value: "BUREAU_SCORE" } })
    })
    await act(async () => {
      await button(renderer, "Confirm Decline").props.onClick()
    })

    expect(childText(renderer.root.findByProps({ role: "alert" }).props.children)).toBe(
      "Failed to process decision",
    )
    expect(renderer.root.findByProps({ "aria-label": "Reason shown to the client" }).props.value).toBe(
      "Verified decline reason",
    )
    expect(button(renderer, "Confirm Decline").props.disabled).toBe(false)
    expect(refresh).not.toHaveBeenCalled()

    await act(async () => renderer.unmount())
  })

  it("blocks a decline until a category is chosen, then posts it", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(response(500, { error: "x" }))
    vi.stubGlobal("fetch", fetchMock)

    let renderer!: ReactTestRenderer
    await act(async () => {
      renderer = create(
        <ApplicationApprovePanel applicationId="application-1" canApprove openChecks={0} />,
      )
    })
    await act(async () => {
      button(renderer, "Decline").props.onClick()
    })

    const select = renderer.root.findByType("select")
    expect(select.props.value).toBe("")
    expect(select.findAllByType("option")[0].props.value).toBe("")
    expect(button(renderer, "Confirm Decline").props.disabled).toBe(true)

    await act(async () => {
      select.props.onChange({ target: { value: "ADVERSE_LISTING" } })
    })
    expect(button(renderer, "Confirm Decline").props.disabled).toBe(false)
    await act(async () => {
      await button(renderer, "Confirm Decline").props.onClick()
    })

    const body = fetchMock.mock.calls[0][1].body as FormData
    expect(body.get("action")).toBe("decline")
    expect(body.get("declineCategory")).toBe("ADVERSE_LISTING")
    expect(body.get("reason")).toBe("Your credit record at the credit bureau shows an adverse listing or a judgment.")

    await act(async () => renderer.unmount())
  })

  // Fair Score audit 2026-10-16: the one "Decline reason" box was shown to the
  // borrower verbatim, so staff notes reached the client.
  it("posts the client's reason and the staff-only note as separate fields", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(response(500, { error: "x" }))
    vi.stubGlobal("fetch", fetchMock)

    let renderer!: ReactTestRenderer
    await act(async () => {
      renderer = create(
        <ApplicationApprovePanel applicationId="application-1" canApprove openChecks={0} />,
      )
    })
    await act(async () => {
      button(renderer, "Decline").props.onClick()
    })
    await act(async () => {
      renderer.root.findByType("select").props.onChange({ target: { value: "FRAUD" } })
    })
    const clientReason = () => renderer.root.findByProps({ "aria-label": "Reason shown to the client" })
    expect(clientReason().props.value).toBe("We could not verify the information in your application.")
    await act(async () => {
      clientReason().props.onChange({ target: { value: "We could not confirm your employment." } })
    })
    await act(async () => {
      renderer.root.findByProps({ "aria-label": "Internal note" }).props.onChange({ target: { value: "Employer number is residential." } })
    })
    // Another category keeps wording staff wrote themselves.
    await act(async () => {
      renderer.root.findByType("select").props.onChange({ target: { value: "POLICY" } })
    })
    expect(clientReason().props.value).toBe("We could not confirm your employment.")
    await act(async () => {
      await button(renderer, "Confirm Decline").props.onClick()
    })

    const body = fetchMock.mock.calls[0][1].body as FormData
    expect(body.get("declineCategory")).toBe("POLICY")
    expect(body.get("reason")).toBe("We could not confirm your employment.")
    expect(body.get("internalNote")).toBe("Employer number is residential.")
    // The WhatsApp notice carries no reason; the help text must not promise it does.
    expect(JSON.stringify(renderer.toJSON())).not.toContain("WhatsApp")

    await act(async () => renderer.unmount())
  })

  it("will not decline as Other until staff write the client's reason", async () => {
    let renderer!: ReactTestRenderer
    await act(async () => {
      renderer = create(
        <ApplicationApprovePanel applicationId="application-1" canApprove openChecks={0} />,
      )
    })
    await act(async () => {
      button(renderer, "Decline").props.onClick()
    })
    await act(async () => {
      renderer.root.findByType("select").props.onChange({ target: { value: "OTHER" } })
    })
    expect(button(renderer, "Confirm Decline").props.disabled).toBe(true)

    await act(async () => renderer.unmount())
  })

  it("clears an approval error when staff starts a separate decline action", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(response(500, {
      error: "Approval service unavailable",
    }))
    vi.stubGlobal("fetch", fetchMock)

    let renderer!: ReactTestRenderer
    await act(async () => {
      renderer = create(
        <ApplicationApprovePanel applicationId="application-1" canApprove openChecks={0} />,
      )
    })

    await act(async () => {
      await button(renderer, "Approve").props.onClick()
    })
    expect(childText(renderer.root.findByProps({ role: "alert" }).props.children)).toBe(
      "Approval service unavailable",
    )

    await act(async () => {
      button(renderer, "Decline").props.onClick()
    })

    expect(renderer.root.findAllByProps({ role: "alert" })).toHaveLength(0)
    expect(button(renderer, "Confirm Decline")).toBeDefined()

    await act(async () => renderer.unmount())
  })

  it("uses action-neutral terminal feedback after returning to draft", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(422, {
        error: "Approval blocked: immutable submission affordability evidence is invalid or has been altered. Return the application to draft and submit it again before approval.",
        affordabilitySnapshot: "submission_changed",
      }))
      .mockResolvedValueOnce(response(200, { ok: true, status: "DRAFT" }))
    vi.stubGlobal("fetch", fetchMock)

    let renderer!: ReactTestRenderer
    await act(async () => {
      renderer = create(
        <ApplicationApprovePanel applicationId="application-1" canApprove openChecks={0} />,
      )
    })

    await act(async () => {
      await button(renderer, "Approve").props.onClick()
    })
    await act(async () => {
      await button(renderer, "Return to Draft and Recapture").props.onClick()
    })

    expect(childText(renderer.root.findByProps({ role: "status" }).props.children)).toBe(
      "Application updated. Refreshing...",
    )
    expect(renderedText(renderer)).not.toContain("Return to Draft")
    expect(refresh).toHaveBeenCalledOnce()

    await act(async () => renderer.unmount())
  })

  it.each([
    {
      label: "transport",
      failure: () => Promise.reject(new Error("offline")),
    },
    {
      label: "unparseable response",
      failure: () => Promise.resolve({
        ok: false,
        status: 502,
        json: async () => {
          throw new Error("invalid JSON")
        },
      }),
    },
  ])("keeps the typed override retryable after a $label failure", async ({ failure }) => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(422, {
        error: "Bureau enquiry required: cannot approve without a current credit bureau check.",
        requiresOverride: true,
        bureauMissing: true,
      }))
      .mockImplementationOnce(failure)
    vi.stubGlobal("fetch", fetchMock)

    let renderer!: ReactTestRenderer
    await act(async () => {
      renderer = create(
        <ApplicationApprovePanel applicationId="application-1" canApprove openChecks={0} />,
      )
    })

    await act(async () => {
      await button(renderer, "Approve").props.onClick()
    })
    const textarea = renderer.root.findByType("textarea")
    await act(async () => {
      textarea.props.onChange({ target: { value: "Retryable override reason" } })
    })
    await act(async () => {
      await button(renderer, "Confirm Override").props.onClick()
    })

    const alert = renderer.root.findByProps({ role: "alert" })
    expect(childText(alert.props.children)).toBe("Network error. Please try again.")
    expect(renderedText(renderer)).toContain("override required")
    expect(renderer.root.findByType("textarea").props.value).toBe(
      "Retryable override reason",
    )
    expect(refresh).not.toHaveBeenCalled()

    await act(async () => renderer.unmount())
  })

  it("disables Approve and shows a warning while checks are open", async () => {
    vi.stubGlobal("fetch", vi.fn())
    let renderer!: ReactTestRenderer
    await act(async () => {
      renderer = create(
        <ApplicationApprovePanel applicationId="application-1" canApprove openChecks={2} />,
      )
    })

    const warning = renderer.root.findByProps({ "data-testid": "open-checks-warning" })
    expect(childText(warning.props.children)).toContain("2 open checks")
    expect(button(renderer, "Approve").props.disabled).toBe(true)
    expect(button(renderer, "Decline").props.disabled).toBe(false)

    await act(async () => renderer.unmount())
  })
})
