// components/settings/ImsModuleToggle.test.tsx
//
// CLAUDE.md treats UI copy as a factual claim. This switch sits in front of a
// FAIS-regulated module, and an operator deciding whether it is safe to turn
// off has nothing to go on but the sentence under it.
//
// The gating boundary is DELIBERATE and asserted here so a future edit cannot
// quietly widen the promise: `requireImsEnabled` gates `app/api/insurance/**`,
// and the two dashboard layouts under `(dashboard)/insurance` and
// `(dashboard)/compliance` redirect. It does NOT gate `app/api/insurers/**`,
// `app/api/products/insurance/**`, `(dashboard)/settings/insurers` or
// `(dashboard)/settings/products/insurance` — live credit life reads insurer
// and insurance-product records, so gating those would break production.
import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ImsModuleToggle } from "./ImsModuleToggle"

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}))

const actEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean
}

/** Every string the component renders, flattened. */
function renderedText(renderer: ReactTestRenderer): string {
  const out: string[] = []
  const walk = (node: unknown): void => {
    if (typeof node === "string") out.push(node)
    else if (Array.isArray(node)) node.forEach(walk)
    else if (node && typeof node === "object" && "children" in node) {
      walk((node as { children: unknown }).children)
    }
  }
  walk(renderer.toJSON())
  return out.join(" ").replace(/\s+/g, " ")
}

describe("ImsModuleToggle copy", () => {
  let text: string

  beforeEach(async () => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    let renderer!: ReactTestRenderer
    await act(async () => {
      renderer = create(<ImsModuleToggle featureIms={true} />)
    })
    text = renderedText(renderer)
  })

  afterEach(() => {
    delete actEnvironment.IS_REACT_ACT_ENVIRONMENT
  })

  it("does not claim the switch closes every insurance screen and endpoint", () => {
    // The old sentence — "Off means staff cannot reach any insurance screen or
    // endpoint" — was false in four places at once.
    expect(text).not.toMatch(/cannot reach any insurance screen or endpoint/i)
    expect(text).not.toMatch(/\bany insurance (screen|endpoint)\b/i)
  })

  it("names what the switch does NOT cover, so the gap is stated rather than implied", () => {
    // Insurer and insurance-product setup stay reachable with the flag off.
    expect(text).toMatch(/insurer/i)
    expect(text).toMatch(/settings/i)
    expect(text).toMatch(/credit life/i)
  })

  it("still says what the switch does cover", () => {
    expect(text).toMatch(/compliance/i)
    expect(text).toMatch(/insurance/i)
  })
})

// ─── Behaviour ───────────────────────────────────────────────────────────────
//
// The copy assertions above pass whether or not `handleChange` does anything —
// deleting the whole fetch body would keep them green. These exercise the save
// itself: the request that goes out, and the two branches that follow it.
//
// The failure branch matters most. A save that silently leaves the switch
// showing the NEW position while the database still holds the old one tells an
// operator the FAIS-regulated module is off when it is on.

/** Radix renders several nested nodes; the switch is the one wired to the handler. */
function switchHandler(renderer: ReactTestRenderer): (next: boolean) => Promise<void> {
  const node = renderer.root.findAll(
    (n) => typeof (n.props as { onCheckedChange?: unknown }).onCheckedChange === "function",
    { deep: true }
  )[0]
  return (node.props as { onCheckedChange: (next: boolean) => Promise<void> }).onCheckedChange
}

/** Whether the switch is currently rendered as on. */
function switchIsChecked(renderer: ReactTestRenderer): boolean {
  const node = renderer.root.findAll(
    (n) => typeof (n.props as { onCheckedChange?: unknown }).onCheckedChange === "function",
    { deep: true }
  )[0]
  return (node.props as { checked: boolean }).checked
}

describe("ImsModuleToggle save behaviour", () => {
  let renderer: ReactTestRenderer
  let fetchMock: ReturnType<typeof vi.fn>

  async function renderToggle(featureIms: boolean) {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    await act(async () => {
      renderer = create(<ImsModuleToggle featureIms={featureIms} />)
    })
  }

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    delete actEnvironment.IS_REACT_ACT_ENVIRONMENT
  })

  it("PATCHes the new value to the IMS settings endpoint", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true, featureIms: false }) })
    await renderToggle(true)

    await act(async () => {
      await switchHandler(renderer)(false)
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("/api/settings/ims")
    expect(init.method).toBe("PATCH")
    expect(JSON.parse(init.body)).toEqual({ featureIms: false })
  })

  it("moves the switch and confirms in words once the save succeeds", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true, featureIms: false }) })
    await renderToggle(true)

    await act(async () => {
      await switchHandler(renderer)(false)
    })

    expect(switchIsChecked(renderer)).toBe(false)
    expect(renderedText(renderer)).toMatch(/switched off/i)
  })

  it("reports the on-state in words when switching on", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true, featureIms: true }) })
    await renderToggle(false)

    await act(async () => {
      await switchHandler(renderer)(true)
    })

    expect(switchIsChecked(renderer)).toBe(true)
    expect(renderedText(renderer)).toMatch(/switched on/i)
  })

  // The load-bearing one: a rejected save must NOT move the switch, or the
  // screen asserts a module state the database does not hold.
  it("leaves the switch untouched when the server rejects the save", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      json: async () => ({ error: "featureIms must be true or false." }),
    })
    await renderToggle(true)

    await act(async () => {
      await switchHandler(renderer)(false)
    })

    expect(switchIsChecked(renderer)).toBe(true)
    const text = renderedText(renderer)
    expect(text).toMatch(/featureIms must be true or false\./)
    expect(text).not.toMatch(/switched (on|off)/i)
  })

  it("leaves the switch untouched when the request itself throws", async () => {
    fetchMock.mockRejectedValue(new Error("network down"))
    await renderToggle(true)

    await act(async () => {
      await switchHandler(renderer)(false)
    })

    expect(switchIsChecked(renderer)).toBe(true)
    expect(renderedText(renderer)).toMatch(/failed to save the setting/i)
  })

  // A failure with no parseable body must still say something. Falling through
  // silently would read as a successful save.
  it("falls back to a generic message when the error body is unreadable", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      json: async () => {
        throw new Error("not json")
      },
    })
    await renderToggle(true)

    await act(async () => {
      await switchHandler(renderer)(false)
    })

    expect(switchIsChecked(renderer)).toBe(true)
    expect(renderedText(renderer)).toMatch(/failed to save the setting/i)
  })
})
