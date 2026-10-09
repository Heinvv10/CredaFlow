import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const trackEvent = vi.fn()
vi.mock("@/lib/analytics/events", () => ({
  trackEvent: (...args: unknown[]) => trackEvent(...args),
}))

import { WhatsAppLauncher } from "./WhatsAppLauncher"
import {
  PORTAL_INTENTS,
  WEBSITE_INTENTS,
  type SupportIntent,
} from "@/lib/support/whatsapp-intents"

const actEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean
}

function trigger(renderer: ReactTestRenderer) {
  return renderer.root.findByType("button")
}

function links(renderer: ReactTestRenderer) {
  return renderer.root.findAllByType("a")
}

function tabIndexes(renderer: ReactTestRenderer) {
  return links(renderer).map((link) => link.props.tabIndex)
}

async function openPanel(renderer: ReactTestRenderer) {
  await act(async () => {
    trigger(renderer).props.onClick()
  })
}

/**
 * Renders with a `createNodeMock` stand-in so `ref.current.focus()` is
 * observable, returning the log of what was focused, in order.
 *
 * Without it `react-test-renderer` resolves every host ref to `null`, which
 * makes the roving-focus effect a permanent no-op: deleting the effect
 * outright still leaves the suite green, and the whole arrow-key contract
 * degrades to bookkeeping over `tabIndex` that never moves real focus. This
 * needs no jsdom.
 */
async function renderWithFocusLog(intents: readonly SupportIntent[]) {
  const focused: string[] = []
  let renderer!: ReactTestRenderer

  await act(async () => {
    renderer = create(<WhatsAppLauncher whatsappE164="+27110000000" intents={intents} />, {
      createNodeMock: (element) => {
        const props = element.props as { children?: unknown }
        const label =
          element.type === "a" ? String(props.children) : String(element.type)
        return { focus: () => focused.push(label) }
      },
    })
  })

  return { renderer, focused }
}

describe("WhatsAppLauncher", () => {
  let renderer!: ReactTestRenderer

  beforeEach(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    trackEvent.mockClear()
  })

  afterEach(async () => {
    await act(async () => renderer.unmount())
    delete actEnvironment.IS_REACT_ACT_ENVIRONMENT
  })

  it("renders only the trigger until it is opened", async () => {
    await act(async () => {
      renderer = create(<WhatsAppLauncher whatsappE164="+27110000000" intents={WEBSITE_INTENTS} />)
    })

    expect(links(renderer)).toHaveLength(0)
    expect(trigger(renderer).props["aria-expanded"]).toBe(false)
  })

  it("renders one correctly-formed link per intent once opened", async () => {
    await act(async () => {
      renderer = create(<WhatsAppLauncher whatsappE164="+27110000000" intents={WEBSITE_INTENTS} />)
    })
    await openPanel(renderer)

    const rendered = links(renderer)
    expect(rendered).toHaveLength(WEBSITE_INTENTS.length)
    expect(trigger(renderer).props["aria-expanded"]).toBe(true)

    // Literal href, not one derived from the module under test.
    expect(rendered[0].props.href).toBe(
      "https://wa.me/27110000000?text=Hi%2C%20I'd%20like%20to%20apply%20for%20a%20loan.",
    )
    for (const link of rendered) {
      expect(link.props.target).toBe("_blank")
      expect(link.props.rel).toContain("noopener")
      expect(link.props.rel).toContain("noreferrer")
    }
  })

  it("reports opening once, and does not report on close", async () => {
    await act(async () => {
      renderer = create(<WhatsAppLauncher whatsappE164="+27110000000" intents={WEBSITE_INTENTS} />)
    })

    await openPanel(renderer)
    expect(trackEvent).toHaveBeenCalledTimes(1)
    expect(trackEvent).toHaveBeenCalledWith("support", "whatsapp_launcher_open")

    await openPanel(renderer) // toggles closed
    expect(trackEvent).toHaveBeenCalledTimes(1)
  })

  it("reports the intent id when an intent is followed", async () => {
    await act(async () => {
      renderer = create(<WhatsAppLauncher whatsappE164="+27110000000" intents={PORTAL_INTENTS} />)
    })
    await openPanel(renderer)
    trackEvent.mockClear()

    await act(async () => {
      links(renderer)[2].props.onClick()
    })

    expect(trackEvent).toHaveBeenCalledWith(
      "support",
      "whatsapp_intent",
      PORTAL_INTENTS[2].id,
    )
  })

  it("closes on Escape", async () => {
    await act(async () => {
      renderer = create(<WhatsAppLauncher whatsappE164="+27110000000" intents={WEBSITE_INTENTS} />)
    })
    await openPanel(renderer)

    const panel = renderer.root.findByProps({ role: "menu" })
    await act(async () => {
      panel.props.onKeyDown({ key: "Escape" })
    })

    expect(links(renderer)).toHaveLength(0)
  })

  it("ignores other keys", async () => {
    await act(async () => {
      renderer = create(<WhatsAppLauncher whatsappE164="+27110000000" intents={WEBSITE_INTENTS} />)
    })
    await openPanel(renderer)

    const panel = renderer.root.findByProps({ role: "menu" })
    await act(async () => {
      panel.props.onKeyDown({ key: "a" })
    })

    // Menu stays open AND the active item doesn't move — a handler that
    // reacts to any key (e.g. closes on everything) would pass the length
    // check alone.
    expect(links(renderer)).toHaveLength(WEBSITE_INTENTS.length)
    expect(tabIndexes(renderer)).toEqual([0, -1, -1, -1])
  })

  it("the first item is active by default on the initial open", async () => {
    // Distinct from the reset test below: this only exercises the
    // `useState(0)` default plus the item's tabIndex wiring. It cannot
    // observe whether `toggle()` re-asserts index 0 on every open, because
    // this is the first open — the default already puts it there.
    await act(async () => {
      renderer = create(<WhatsAppLauncher whatsappE164="+27110000000" intents={WEBSITE_INTENTS} />)
    })
    await openPanel(renderer)

    expect(tabIndexes(renderer)).toEqual([0, -1, -1, -1])
  })

  it("resets the active item to the first when reopened after moving away", async () => {
    await act(async () => {
      renderer = create(<WhatsAppLauncher whatsappE164="+27110000000" intents={WEBSITE_INTENTS} />)
    })
    await openPanel(renderer)

    const panel = renderer.root.findByProps({ role: "menu" })
    await act(async () => {
      panel.props.onKeyDown({ key: "ArrowDown", preventDefault: vi.fn() })
    })
    expect(tabIndexes(renderer)).toEqual([-1, 0, -1, -1])

    // Close (moving the active index off 0 stays in state) and reopen.
    await act(async () => {
      panel.props.onKeyDown({ key: "Escape" })
    })
    await openPanel(renderer)

    expect(tabIndexes(renderer)).toEqual([0, -1, -1, -1])
  })

  it("ArrowDown moves the active item forward, wrapping from last to first", async () => {
    await act(async () => {
      renderer = create(<WhatsAppLauncher whatsappE164="+27110000000" intents={WEBSITE_INTENTS} />)
    })
    await openPanel(renderer)

    const panel = renderer.root.findByProps({ role: "menu" })
    const preventDefault = vi.fn()

    await act(async () => {
      panel.props.onKeyDown({ key: "ArrowDown", preventDefault })
    })
    expect(tabIndexes(renderer)).toEqual([-1, 0, -1, -1])

    await act(async () => {
      panel.props.onKeyDown({ key: "ArrowDown", preventDefault })
    })
    expect(tabIndexes(renderer)).toEqual([-1, -1, 0, -1])

    await act(async () => {
      panel.props.onKeyDown({ key: "ArrowDown", preventDefault })
    })
    expect(tabIndexes(renderer)).toEqual([-1, -1, -1, 0])

    // Wraps from the last item back to the first.
    await act(async () => {
      panel.props.onKeyDown({ key: "ArrowDown", preventDefault })
    })
    expect(tabIndexes(renderer)).toEqual([0, -1, -1, -1])

    expect(preventDefault).toHaveBeenCalledTimes(4)
  })

  it("ArrowUp moves the active item backward, wrapping from first to last", async () => {
    await act(async () => {
      renderer = create(<WhatsAppLauncher whatsappE164="+27110000000" intents={WEBSITE_INTENTS} />)
    })
    await openPanel(renderer)

    const panel = renderer.root.findByProps({ role: "menu" })
    const preventDefault = vi.fn()

    // From the first item, ArrowUp wraps to the last.
    await act(async () => {
      panel.props.onKeyDown({ key: "ArrowUp", preventDefault })
    })
    expect(tabIndexes(renderer)).toEqual([-1, -1, -1, 0])

    await act(async () => {
      panel.props.onKeyDown({ key: "ArrowUp", preventDefault })
    })
    expect(tabIndexes(renderer)).toEqual([-1, -1, 0, -1])

    expect(preventDefault).toHaveBeenCalledTimes(2)
  })

  it("Home jumps to the first item and End to the last", async () => {
    await act(async () => {
      renderer = create(<WhatsAppLauncher whatsappE164="+27110000000" intents={WEBSITE_INTENTS} />)
    })
    await openPanel(renderer)

    const panel = renderer.root.findByProps({ role: "menu" })
    const preventDefault = vi.fn()

    await act(async () => {
      panel.props.onKeyDown({ key: "End", preventDefault })
    })
    expect(tabIndexes(renderer)).toEqual([-1, -1, -1, 0])

    await act(async () => {
      panel.props.onKeyDown({ key: "Home", preventDefault })
    })
    expect(tabIndexes(renderer)).toEqual([0, -1, -1, -1])

    expect(preventDefault).toHaveBeenCalledTimes(2)
  })

  it("closes the menu on Tab", async () => {
    await act(async () => {
      renderer = create(<WhatsAppLauncher whatsappE164="+27110000000" intents={WEBSITE_INTENTS} />)
    })
    await openPanel(renderer)

    const panel = renderer.root.findByProps({ role: "menu" })
    await act(async () => {
      panel.props.onKeyDown({ key: "Tab" })
    })

    expect(links(renderer)).toHaveLength(0)
  })

  it("moves real focus onto the active item as the active index changes", async () => {
    const rendered = await renderWithFocusLog(WEBSITE_INTENTS)
    renderer = rendered.renderer
    const { focused } = rendered

    // Nothing is focused while closed — the panel isn't mounted.
    expect(focused).toEqual([])

    await openPanel(renderer)
    expect(focused).toEqual(["Apply for a loan"])

    const panel = renderer.root.findByProps({ role: "menu" })
    await act(async () => {
      panel.props.onKeyDown({ key: "ArrowDown", preventDefault: vi.fn() })
    })
    expect(focused).toEqual(["Apply for a loan", "Rates and repayments"])

    await act(async () => {
      panel.props.onKeyDown({ key: "End", preventDefault: vi.fn() })
    })
    expect(focused).toEqual([
      "Apply for a loan",
      "Rates and repayments",
      "Log a complaint",
    ])
  })

  it("returns focus to the trigger when Escape closes the panel", async () => {
    const rendered = await renderWithFocusLog(WEBSITE_INTENTS)
    renderer = rendered.renderer
    const { focused } = rendered

    await openPanel(renderer)
    const panel = renderer.root.findByProps({ role: "menu" })
    await act(async () => {
      panel.props.onKeyDown({ key: "Escape" })
    })

    // Focus must not be left on a link that no longer exists.
    expect(focused).toEqual(["Apply for a loan", "button"])
  })

  it("exposes the ARIA menu roles the keyboard contract rests on", async () => {
    await act(async () => {
      renderer = create(<WhatsAppLauncher whatsappE164="+27110000000" intents={WEBSITE_INTENTS} />)
    })

    expect(trigger(renderer).props["aria-haspopup"]).toBe("menu")
    // Closed, the panel is unmounted, so aria-controls must not name an
    // IDREF that resolves to nothing.
    expect(trigger(renderer).props["aria-controls"]).toBeUndefined()

    await openPanel(renderer)

    const panel = renderer.root.findByProps({ role: "menu" })
    expect(panel.props.role).toBe("menu")
    expect(panel.props["aria-label"]).toBe("Chat to us on WhatsApp")
    expect(trigger(renderer).props["aria-controls"]).toBe(panel.props.id)

    // Without menuitem on each link the roving tabindex and arrow keys are
    // unexplained behaviour rather than an implemented menu.
    const items = links(renderer)
    expect(items).toHaveLength(WEBSITE_INTENTS.length)
    for (const item of items) {
      expect(item.props.role).toBe("menuitem")
    }

    // role="menu" accepts only menuitem/group/separator as children, so the
    // heading must be hidden from the accessibility tree.
    expect(renderer.root.findByType("p").props.role).toBe("presentation")
  })

  it("closes the panel when an intent is followed", async () => {
    await act(async () => {
      renderer = create(<WhatsAppLauncher whatsappE164="+27110000000" intents={WEBSITE_INTENTS} />)
    })
    await openPanel(renderer)
    expect(links(renderer)).toHaveLength(WEBSITE_INTENTS.length)

    await act(async () => {
      links(renderer)[1].props.onClick()
    })

    // The panel must not stay open behind the WhatsApp hand-off.
    expect(links(renderer)).toHaveLength(0)
    expect(trigger(renderer).props["aria-expanded"]).toBe(false)
  })

  it("renders the portal intent set when given it", async () => {
    await act(async () => {
      renderer = create(<WhatsAppLauncher whatsappE164="+27110000000" intents={PORTAL_INTENTS} />)
    })
    await openPanel(renderer)

    expect(links(renderer)).toHaveLength(PORTAL_INTENTS.length)
    expect(links(renderer)[0].props.href).toBe(
      "https://wa.me/27110000000?text=Hi%2C%20I%20need%20help%20with%20my%20loan%20account.",
    )
  })

  it("emits its own base classes when no positioning override is given", async () => {
    await act(async () => {
      renderer = create(<WhatsAppLauncher whatsappE164="+27110000000" intents={WEBSITE_INTENTS} />)
    })

    const root = renderer.root.findByProps({ "data-testid": "whatsapp-launcher" })
    const className = root.props.className as string

    // The website mounts pass no className at all, so the component's own
    // classes are the entire positioning — asserting only the caller's
    // override would pass even if these stopped being emitted.
    expect(className).toContain("fixed")
    expect(className).toContain("right-4")
    expect(className).toContain("z-40")
    expect(className).toMatch(/(^|\s)bottom-6(\s|$)/)
  })

  it("lets a caller-supplied positioning class override the base offset", async () => {
    await act(async () => {
      renderer = create(
        <WhatsAppLauncher whatsappE164="+27110000000" intents={PORTAL_INTENTS} className="bottom-20 md:bottom-6" />,
      )
    })

    const root = renderer.root.findByProps({ "data-testid": "whatsapp-launcher" })
    const className = root.props.className as string

    expect(className).toContain("fixed")
    expect(className).toContain("bottom-20")
    expect(className).toContain("md:bottom-6")
    // tailwind-merge must actually DROP the base `bottom-6`, or the portal
    // pill sits under the h-16 mobile nav whatever the caller asks for.
    // `md:bottom-6` is a different variant and legitimately survives.
    expect(className).not.toMatch(/(^|\s)bottom-6(\s|$)/)
  })
  it("puts the chat action first as a button that fires onSelect and closes the menu", async () => {
    const onSelect = vi.fn()
    await act(async () => {
      renderer = create(
        <WhatsAppLauncher
          whatsappE164="+27110000000"
          intents={WEBSITE_INTENTS}
          chatAction={{ label: "Chat with our assistant", onSelect }}
        />,
      )
    })
    await openPanel(renderer)

    const items = renderer.root.findAllByProps({ role: "menuitem" })
    expect(items[0].type).toBe("button")
    expect(items[0].props.children).toBe("Chat with our assistant")
    expect(items).toHaveLength(WEBSITE_INTENTS.length + 1)
    expect(items[1].type).toBe("a")

    await act(async () => {
      items[0].props.onClick()
    })

    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(renderer.root.findAllByProps({ role: "menuitem" })).toHaveLength(0)
  })

  it("keeps an intent link as the first item when there is no chat action", async () => {
    await act(async () => {
      renderer = create(<WhatsAppLauncher whatsappE164="+27110000000" intents={WEBSITE_INTENTS} />)
    })
    await openPanel(renderer)

    const items = renderer.root.findAllByProps({ role: "menuitem" })
    expect(items[0].type).toBe("a")
    expect(items).toHaveLength(WEBSITE_INTENTS.length)
  })

  it("renders nothing when the lender has no WhatsApp number and there is no chat action", async () => {
    await act(async () => {
      renderer = create(<WhatsAppLauncher whatsappE164={null} intents={WEBSITE_INTENTS} />)
    })
    expect(renderer.toJSON()).toBeNull()
  })

  it("offers only the chat action when the lender has no WhatsApp number", async () => {
    await act(async () => {
      renderer = create(
        <WhatsAppLauncher
          whatsappE164={null}
          intents={WEBSITE_INTENTS}
          chatAction={{ label: "Chat with our assistant", onSelect: vi.fn() }}
        />,
      )
    })
    await openPanel(renderer)

    const items = renderer.root.findAllByProps({ role: "menuitem" })
    expect(items).toHaveLength(1)
    expect(items[0].type).toBe("button")
  })
})
