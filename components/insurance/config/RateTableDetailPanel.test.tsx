// @vitest-environment jsdom
// The entry-age warning links to the eligibility screen, and next/link's
// use-intersection hook touches `self`/`requestIdleCallback`, which the suite's
// default "node" environment does not provide. Per-file, as
// ClientCommsTab.test.tsx does — the default stays `node` for ~570 other files.
//
// The two things about this panel that are not obvious from the code, and both
// of which are correctness rather than polish:
//
//   1. An ACTIVE or RETIRED card is READ-ONLY, as it is in the API. Every write
//      route answers 409 on a non-DRAFT table. Rendering an edit control there
//      is not a cosmetic slip — it is an invitation to a refusal, on the screen
//      where a staff member is trying to change a rate. What they need instead
//      is "Create new version", because that is what a rate change IS.
//   2. Server errors are shown VERBATIM. These routes answer with which draft
//      lost a race and which two bands would price the same life; a generic
//      "something went wrong" throws away the only thing that says what to do.
//
// `@testing-library/react` is not installed in this repo — component tests use
// `react-test-renderer`, as ImsModuleToggle.test.tsx does.
import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { RateTableDetailPanel } from "./RateTableDetailPanel"
import type { RateTableDetail } from "@/lib/settings-insurance-config"

vi.mock("@/lib/toast", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}))

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }

/**
 * A NON-UNIFORM card. A fixture whose bands all carried the same ages and the
 * same cover would render one cell, and every assertion about what the panel
 * shows of a rate card would hold for a panel that showed almost nothing.
 */
function table(status: RateTableDetail["status"]): RateTableDetail {
  return {
    id: "rt1",
    productId: "p1",
    insurerId: null,
    version: 3,
    name: "Funeral rates 2026",
    status,
    basis: "AGE_BANDED",
    effectiveFrom: "2026-08-01T00:00:00.000Z",
    effectiveTo: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    bands: [
      { id: "b1", rateTableId: "rt1", lifeType: "MAIN_MEMBER", minAge: 18, maxAge: 40, sumAssured: "10000", premiumAmount: "45" },
      { id: "b2", rateTableId: "rt1", lifeType: "MAIN_MEMBER", minAge: 41, maxAge: 65, sumAssured: "10000", premiumAmount: "88" },
      { id: "b3", rateTableId: "rt1", lifeType: "SPOUSE", minAge: 18, maxAge: 65, sumAssured: "20000", premiumAmount: "71.5" },
    ],
  }
}

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

/** Buttons, by the text they carry. */
function buttonLabels(renderer: ReactTestRenderer): string[] {
  return renderer.root
    .findAll((n) => n.type === "button", { deep: true })
    .map((n) => {
      const flat: string[] = []
      const walk = (child: unknown): void => {
        if (typeof child === "string") flat.push(child)
        else if (Array.isArray(child)) child.forEach(walk)
      }
      walk(n.props.children)
      return flat.join(" ").trim()
    })
}

function clickButton(renderer: ReactTestRenderer, label: string): () => void {
  const node = renderer.root.findAll((n) => n.type === "button", { deep: true }).find((n) => {
    const flat: string[] = []
    const walk = (child: unknown): void => {
      if (typeof child === "string") flat.push(child)
      else if (Array.isArray(child)) child.forEach(walk)
    }
    walk(n.props.children)
    return flat.join(" ").trim() === label
  })
  if (!node) throw new Error(`No button labelled "${label}". Present: ${buttonLabels(renderer).join(", ")}`)
  return node.props.onClick as () => void
}

async function render(props: Partial<Parameters<typeof RateTableDetailPanel>[0]> & { table: RateTableDetail }) {
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  let renderer!: ReactTestRenderer
  await act(async () => {
    renderer = create(
      <RateTableDetailPanel
        table={props.table}
        productId={props.productId ?? "p1"}
        rules={props.rules ?? []}
        canWrite={props.canWrite ?? true}
        onChanged={props.onChanged ?? vi.fn()}
        onCreateVersionFrom={props.onCreateVersionFrom ?? vi.fn()}
        creatingVersion={props.creatingVersion ?? false}
      />
    )
  })
  return renderer
}

afterEach(() => {
  vi.unstubAllGlobals()
  delete actEnvironment.IS_REACT_ACT_ENVIRONMENT
})

describe("a DRAFT rate table", () => {
  it("offers the edit controls the API will accept", async () => {
    const labels = buttonLabels(await render({ table: table("DRAFT") }))
    expect(labels).toContain("Activate")
    expect(labels).toContain("Delete draft")
    expect(labels).toContain("Add band")
    expect(labels).toContain("Save details")
    expect(labels).not.toContain("Create new version")
  })

  it("renders the grid the bands describe, non-uniform premiums and all", async () => {
    const text = renderedText(await render({ table: table("DRAFT") }))
    expect(text).toMatch(/R 45\.00/)
    expect(text).toMatch(/R 88\.00/)
    expect(text).toMatch(/R 71\.50/)
    expect(text).toMatch(/18–40/)
    expect(text).toMatch(/41–65/)
  })
})

describe("an ACTIVE rate table is read-only, as it is in the API", () => {
  it("offers 'Create new version' and NO control the server would 409", async () => {
    const labels = buttonLabels(await render({ table: table("ACTIVE") }))
    expect(labels).toContain("Create new version")
    expect(labels).toContain("Retire")
    // Every one of these is a 409 against a non-DRAFT table.
    expect(labels).not.toContain("Add band")
    expect(labels).not.toContain("Save details")
    expect(labels).not.toContain("Activate")
    expect(labels).not.toContain("Delete draft")
  })

  it("says why, rather than leaving the missing controls unexplained", async () => {
    const text = renderedText(await render({ table: table("ACTIVE") }))
    expect(text).toMatch(/in force and cannot be edited/i)
    expect(text).toMatch(/create a new version/i)
    expect(text).toMatch(/policies already sold keep this rate/i)
  })

  it("still shows the rates, because a frozen card is the record of what was sold", async () => {
    expect(renderedText(await render({ table: table("ACTIVE") }))).toMatch(/R 45\.00/)
  })
})

describe("a RETIRED rate table", () => {
  it("cannot be edited, activated or retired again", async () => {
    const labels = buttonLabels(await render({ table: table("RETIRED") }))
    expect(labels).toContain("Create new version")
    expect(labels).not.toContain("Retire")
    expect(labels).not.toContain("Activate")
    expect(labels).not.toContain("Add band")
  })
})

describe("a reader without write permission", () => {
  it("gets no write control on a DRAFT either — the API requires INSURANCE_OFFICER", async () => {
    const labels = buttonLabels(await render({ table: table("DRAFT"), canWrite: false }))
    expect(labels).not.toContain("Activate")
    expect(labels).not.toContain("Add band")
    expect(labels).not.toContain("Delete draft")
    expect(labels).not.toContain("Create new version")
  })
})

describe("server refusals reach the operator verbatim", () => {
  it("shows the activate route's own 409 text", async () => {
    vi.stubGlobal("confirm", vi.fn(() => true))
    const refusal =
      "Activation was rolled back: it would have left this product without exactly one rate card in force. Nothing was changed."
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: refusal }),
    })
    vi.stubGlobal("fetch", fetchMock)

    const renderer = await render({ table: table("DRAFT") })
    await act(async () => {
      await clickButton(renderer, "Activate")()
    })

    expect(renderedText(renderer)).toContain(refusal)
  })

  it("does not send the request at all when the confirmation is declined", async () => {
    vi.stubGlobal("confirm", vi.fn(() => false))
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    const renderer = await render({ table: table("DRAFT") })
    await act(async () => {
      await clickButton(renderer, "Activate")()
    })

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("warns in the confirmation that activating retires the card in force", async () => {
    const confirmMock = vi.fn((_message: string) => false)
    vi.stubGlobal("confirm", confirmMock)
    vi.stubGlobal("fetch", vi.fn())

    const renderer = await render({ table: table("DRAFT") })
    await act(async () => {
      await clickButton(renderer, "Activate")()
    })

    const message = confirmMock.mock.calls[0][0]
    expect(message).toMatch(/RETIRED in the same transaction/)
    expect(message).toMatch(/keep the rate they were sold at/)
  })

  it("falls back to the status code when the error body will not parse", async () => {
    vi.stubGlobal("confirm", vi.fn(() => true))
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => {
          throw new Error("not json")
        },
      })
    )

    const renderer = await render({ table: table("DRAFT") })
    await act(async () => {
      await clickButton(renderer, "Activate")()
    })

    expect(renderedText(renderer)).toMatch(/HTTP 500/)
  })
})

// The two faults a card can carry that every other check on this screen misses.
describe("a card that looks complete", () => {
  it("says plainly which life types it cannot price at all", async () => {
    // The fixture is contiguous and unambiguous: no gap, no overlap, every cell
    // filled. It still cannot price a child or an extended-family member, and
    // before this the only screen that said so was Settings → Insurance Module.
    const text = renderedText(await render({ table: table("DRAFT") }))
    expect(text).toMatch(/No band on this card prices a child, at any age or cover amount/i)
    expect(text).toMatch(/No band on this card prices an extended family/i)
    expect(text).toMatch(/cannot be priced at all/i)
    // Main member and spouse DO have bands, so they must not be named.
    expect(text).not.toMatch(/No band on this card prices a main member/i)
    expect(text).not.toMatch(/No band on this card prices a spouse/i)
  })

  it("warns when the accepted entry ages run past what the card prices", async () => {
    // The card's main-member bands stop at 65. The insurer accepts to 70.
    // Neither screen is wrong on its own; together they strand five years.
    const text = renderedText(
      await render({
        table: table("DRAFT"),
        rules: [
          { id: "r1", productId: "p1", ruleType: "MAX_ENTRY_AGE", lifeScope: "ALL_LIVES", numericValue: "70", textValue: null, active: true },
        ],
      })
    )
    expect(text).toMatch(/do not match what this card prices/i)
    expect(text).toMatch(/Ages 66-70/)
    expect(text).toMatch(/screen as eligible and then fail to price/i)
  })

  it("says nothing about entry ages when the rules and the card agree", async () => {
    const text = renderedText(
      await render({
        table: table("DRAFT"),
        rules: [
          { id: "r1", productId: "p1", ruleType: "MAX_ENTRY_AGE", lifeScope: "ALL_LIVES", numericValue: "65", textValue: null, active: true },
          { id: "r2", productId: "p1", ruleType: "MIN_ENTRY_AGE", lifeScope: "ALL_LIVES", numericValue: "18", textValue: null, active: true },
        ],
      })
    )
    expect(text).not.toMatch(/do not match what this card prices/i)
  })

  it("invents no disagreement when the rules could not be loaded", async () => {
    const text = renderedText(await render({ table: table("DRAFT"), rules: [] }))
    expect(text).not.toMatch(/do not match what this card prices/i)
  })
})

describe("the retire confirmation", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn())
  })

  it("states that the product can then no longer be sold", async () => {
    const confirmMock = vi.fn((_message: string) => false)
    vi.stubGlobal("confirm", confirmMock)

    const renderer = await render({ table: table("ACTIVE") })
    await act(async () => {
      await clickButton(renderer, "Retire")()
    })

    expect(confirmMock.mock.calls[0][0]).toMatch(
      /cannot be quoted or sold/
    )
  })
})

describe("the editable fields follow the table being shown", () => {
  const nameInput = (r: ReactTestRenderer) =>
    r.root.findAll((n) => n.type === "input" && n.props.className?.includes("rounded-lg") && n.props.type !== "date")[0]
  const props = (t: RateTableDetail) => ({
    table: t,
    productId: "p1",
    rules: [],
    canWrite: true,
    onChanged: vi.fn(),
    onCreateVersionFrom: vi.fn(),
    creatingVersion: false,
  })

  it("replaces version 1's name with version 2's when another table is selected", async () => {
    const renderer = await render({ table: table("DRAFT") })
    expect(nameInput(renderer).props.value).toBe("Funeral rates 2026")
    await act(async () => {
      renderer.update(<RateTableDetailPanel {...props({ ...table("DRAFT"), id: "rt2", name: "Funeral rates 2027" })} />)
    })
    expect(nameInput(renderer).props.value).toBe("Funeral rates 2027")
  })

  it("keeps an unsaved edit across a parent re-render that hands over an equal table", async () => {
    const renderer = await render({ table: table("DRAFT") })
    await act(async () => {
      nameInput(renderer).props.onChange({ target: { value: "Half-typed" } })
    })
    // The manager hands over a fresh object after every refresh.
    await act(async () => {
      renderer.update(<RateTableDetailPanel {...props(table("DRAFT"))} />)
    })
    expect(nameInput(renderer).props.value).toBe("Half-typed")
  })
})
