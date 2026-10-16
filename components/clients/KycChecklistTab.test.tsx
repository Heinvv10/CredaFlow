import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { KycChecklistTab } from "@/components/clients/KycChecklistTab"
import { VERIFICATION_RESTORABLE_COPY } from "@/lib/kyc/verification-restorable"

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }))
vi.mock("@/lib/toast", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

const actEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean
}

const ID_DOC = {
  id: "id-doc-1",
  docType: "ID_COPY",
  fileName: "id.jpg",
  mimeType: "image/jpeg",
  fileSize: 1024,
  deletedAt: null,
  verified: false,
  verifiedAt: null,
  verificationNote: null,
  verificationRejectedById: null,
  extractionStatus: "done",
  createdAt: "2026-08-14T12:00:00.000Z",
  extractionResult: {
    documentNumber: { value: "9001015000086" },
    firstName: { value: "Nomsa" },
    surname: { value: "Qatest" },
    dateOfBirth: { value: "1990-01-01" },
  },
}

/** The 409 the route returns when applying would strand existing evidence. */
const REVOCATION_REFUSAL = {
  error:
    "Applying this document changes the client's identity details, which makes " +
    "this client's KYC verification (physical), 2 verified selfies and " +
    "1 credit-bureau check (a re-pull needs fresh consent) unusable.",
  identityRevocation: {
    changedFields: ["firstName"],
    verifiedSelfies: 2,
    bureauChecks: 1,
    avsChecks: 0,
    revokesVerifiedKyc: true,
  },
}

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response
}

/** Visible text of a test instance, including nested elements. */
function textOf(node: { children: unknown[] }): string {
  return node.children
    .map((child) =>
      typeof child === "string"
        ? child
        : textOf(child as { children: unknown[] }),
    )
    .join("")
}

/**
 * Concatenated visible text. NOT JSON.stringify(toJSON()): React splits an
 * interpolated line like {count} verified selfie{s} into separate text nodes,
 * so a serialised tree never contains the sentence a human reads.
 */
function allText(renderer: ReactTestRenderer): string {
  return textOf(renderer.root as unknown as { children: unknown[] })
}

async function mountWithApplyResponses(responses: Response[]) {
  const fetchMock = vi.fn()
  // Anything not explicitly queued is a document-list read: the tab loads one
  // on mount and again after every successful apply.
  fetchMock.mockResolvedValue(jsonResponse(200, [ID_DOC]))
  // The queue is consumed in order ahead of the default: mount first, then one
  // entry per apply attempt this test drives.
  fetchMock.mockResolvedValueOnce(jsonResponse(200, [ID_DOC]))
  for (const response of responses) fetchMock.mockResolvedValueOnce(response)
  vi.stubGlobal("fetch", fetchMock)

  let renderer!: ReactTestRenderer
  await act(async () => {
    renderer = create(<KycChecklistTab clientId="client-1" kycStatus="VERIFIED" />)
  })
  return { renderer, fetchMock }
}

async function clickButtonContaining(renderer: ReactTestRenderer, label: string) {
  const button = renderer.root
    .findAll((node) => node.type === "button", { deep: true })
    .find((node) => textOf(node).includes(label))
  if (!button) throw new Error(`no button containing ${label}`)
  await act(async () => { button.props.onClick() })
}

describe("KycChecklistTab identity-revocation acknowledgement", () => {
  beforeEach(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    delete actEnvironment.IS_REACT_ACT_ENVIRONMENT
  })

  // The route refuses first and proceeds only on an explicit acknowledgement.
  // Without this half of the contract the 409 is not a warning, it is a dead
  // end: staff get a toast and no way to complete a thing they are allowed to
  // do. The apply button posted only { documentId } and had no such path.
  it("offers the operator a way through the refusal instead of a dead end", async () => {
    const { renderer, fetchMock } = await mountWithApplyResponses([
      jsonResponse(409, REVOCATION_REFUSAL),
      jsonResponse(200, { applied: ["firstName"] }),
    ])

    await clickButtonContaining(renderer, "Apply")

    // The dialog must name what is actually at stake, from the route's own
    // counts — not a generic "are you sure".
    const shown = allText(renderer)
    expect(shown).toContain("firstName")
    expect(shown).toContain("2 verified selfie")
    expect(shown).toContain("1 credit-bureau check")
    expect(shown).toContain("fresh consent")
    // avsChecks is 0 here, so it must not be listed.
    expect(shown).not.toContain("bank-account verification")

    await clickButtonContaining(renderer, "Apply and revoke")

    const [, applyCall] = fetchMock.mock.calls
    expect(JSON.parse(applyCall[1].body)).toEqual({ documentId: "id-doc-1" })
    const [, , acknowledgedCall] = fetchMock.mock.calls
    expect(JSON.parse(acknowledgedCall[1].body)).toEqual({
      documentId: "id-doc-1",
      acknowledgeIdentityRevocation: true,
    })
  })

  it("sends no acknowledgement when the operator cancels", async () => {
    const { renderer, fetchMock } = await mountWithApplyResponses([
      jsonResponse(409, REVOCATION_REFUSAL),
    ])

    await clickButtonContaining(renderer, "Apply")
    await clickButtonContaining(renderer, "Cancel")

    expect(allText(renderer)).not.toContain("Apply and revoke")
    // Mount fetch + the one refused apply. Cancel issues nothing, and a refused
    // apply changes no server state so there is nothing to refetch.
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  // The route checks the APPROVED-application binding BEFORE the acknowledgement,
  // so a confirm can come back refused for a reason the dialog knows nothing
  // about — someone approved the application between the refusal and the
  // confirm. Leaving the dialog up would show the first refusal's counts next
  // to an unrelated error, and every further click repeats it.
  it("closes the dialog when the confirm is refused for a different reason", async () => {
    const { renderer } = await mountWithApplyResponses([
      jsonResponse(409, REVOCATION_REFUSAL),
      jsonResponse(409, {
        error: "Cannot apply extraction: application APP-0001 is approved",
      }),
    ])

    await clickButtonContaining(renderer, "Apply")
    await clickButtonContaining(renderer, "Apply and revoke")

    expect(allText(renderer)).not.toContain("Apply and revoke")
    expect(allText(renderer)).not.toContain("2 verified selfie")
  })

  // A successful apply can revoke evidence server-side (a bank-detail change
  // un-verifies the statements it no longer matches). A badge still reading
  // "Verified" for a document that is not is a false claim about the file.
  it("refetches documents after a successful apply", async () => {
    const { renderer, fetchMock } = await mountWithApplyResponses([
      jsonResponse(200, { applied: ["firstName"] }),
    ])

    await clickButtonContaining(renderer, "Apply")

    const documentListCalls = fetchMock.mock.calls.filter(
      ([url]) => url === "/api/clients/client-1/documents",
    )
    expect(documentListCalls).toHaveLength(2)
  })

  // A 409 for any OTHER reason (an APPROVED application binding the field)
  // carries no identityRevocation and must not open a dialog offering to
  // override something this flow cannot override.
  it("does not offer acknowledgement for a refusal it cannot override", async () => {
    const { renderer } = await mountWithApplyResponses([
      jsonResponse(409, {
        error: "Cannot apply extraction: application APP-0001 is approved",
      }),
    ])

    await clickButtonContaining(renderer, "Apply")

    expect(allText(renderer)).not.toContain("Apply and revoke")
  })
})

describe("KycChecklistTab restorable-verification hint", () => {
  beforeEach(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, [{ ...ID_DOC, verified: true }])))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    delete actEnvironment.IS_REACT_ACT_ENVIRONMENT
  })

  async function mount(kycStatus: string, verificationRestorable: boolean) {
    let renderer!: ReactTestRenderer
    await act(async () => {
      renderer = create(
        <KycChecklistTab clientId="client-1" kycStatus={kycStatus} verificationRestorable={verificationRestorable} />,
      )
    })
    return allText(renderer)
  }

  it("tells staff a re-verification would restore VERIFIED", async () => {
    expect(await mount("PENDING", true)).toContain(VERIFICATION_RESTORABLE_COPY)
  })

  it("says nothing when the evidence would not verify, or the client is not PENDING", async () => {
    expect(await mount("PENDING", false)).not.toContain(VERIFICATION_RESTORABLE_COPY)
    expect(await mount("VERIFIED", true)).not.toContain(VERIFICATION_RESTORABLE_COPY)
  })
})

// READONLY views and lists only (Hein, 2026-10-16). The server refuses every
// write, so each control below would be a dead button.
describe("KycChecklistTab for a read-only role", () => {
  beforeEach(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, [ID_DOC])))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    delete actEnvironment.IS_REACT_ACT_ENVIRONMENT
  })

  async function buttonLabels(readOnly: boolean): Promise<string[]> {
    let renderer!: ReactTestRenderer
    await act(async () => {
      renderer = create(<KycChecklistTab clientId="client-1" kycStatus="PENDING" readOnly={readOnly} />)
    })
    return renderer.root
      .findAll((node) => node.type === "button", { deep: true })
      .map((node) => textOf(node).trim())
  }

  it("offers View and nothing that changes a document", async () => {
    const labels = await buttonLabels(true)
    expect(labels).toContain("View")
    for (const write of ["Upload", "Re-upload", "Verify", "Reject", "Apply to profile"]) {
      expect(labels).not.toContain(write)
    }
  })

  it("still offers the write controls to a writing role", async () => {
    const labels = await buttonLabels(false)
    expect(labels).toEqual(expect.arrayContaining(["View", "Upload", "Verify", "Reject", "Apply to profile"]))
  })
})
