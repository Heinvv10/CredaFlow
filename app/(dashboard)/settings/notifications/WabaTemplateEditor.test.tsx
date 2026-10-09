import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { WabaTemplateEditor, type WabaTemplate } from "./WabaTemplateEditor"

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }

function template(overrides: Partial<WabaTemplate> = {}): WabaTemplate {
  return {
    id: "tpl1",
    event: "loan_approved",
    wabaTemplateName: "loan_approved",
    language: "en",
    category: "SERVICE",
    headerContent: null,
    bodyTemplate: "Hi {{firstName}}, loan {{loanRef}} is approved.",
    footer: null,
    buttons: null,
    active: true,
    providerStatus: null,
    providerTemplateId: null,
    ...overrides,
  }
}

/** The rendered create-shape payload (the <pre> preview pane). */
function previewText(renderer: ReactTestRenderer): string {
  const pre = renderer.root.findAllByType("pre")[0]
  const children = Array.isArray(pre.props.children) ? pre.props.children : [pre.props.children]
  return children.filter((c: unknown) => typeof c === "string").join("")
}

function textareaFor(renderer: ReactTestRenderer) {
  return renderer.root.findAllByType("textarea")[0]
}

function inputByLabel(renderer: ReactTestRenderer, label: string) {
  return renderer.root.findAll(
    (n) => (n.type === "input" || n.type === "select") && n.props["aria-label"] === label,
  )[0]
}

function buttonWithText(renderer: ReactTestRenderer, text: string) {
  return renderer.root.findAllByType("button").find((b) => {
    const children = Array.isArray(b.props.children) ? b.props.children.flat() : [b.props.children]
    return children.some((c: unknown) => typeof c === "string" && c.includes(text))
  })
}

let renderer: ReactTestRenderer

beforeEach(() => {
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(() => {
  act(() => renderer?.unmount())
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function render(templates: WabaTemplate[]) {
  act(() => { renderer = create(<WabaTemplateEditor templates={templates} />) })
  return renderer
}

describe("live create-shape preview", () => {
  it("shows the operator Meta's {{1}} renumbering, not the authored names", () => {
    render([template()])
    const payload = JSON.parse(previewText(renderer))
    const body = payload.components.find((c: { type: string }) => c.type === "BODY")
    expect(body.text).toBe("Hi {{1}}, loan {{2}} is approved.")
    expect(body.example.body_text[0]).toEqual(["firstName", "loanRef"])
    expect(payload.name).toBe("loan_approved")
    expect(payload.category).toBe("UTILITY")
  })

  it("renumbers a repeated variable to one index, matching what is sent", () => {
    render([template({ bodyTemplate: "Hi {{name}} — bye {{name}}" })])
    const payload = JSON.parse(previewText(renderer))
    const body = payload.components.find((c: { type: string }) => c.type === "BODY")
    expect(body.text).toBe("Hi {{1}} — bye {{1}}")
    expect(body.example.body_text[0]).toEqual(["name"])
  })

  it("surfaces the builder's own message for a literal {{1}} instead of a payload", () => {
    render([template()])
    act(() => { textareaFor(renderer).props.onChange({ target: { value: "Hi {{1}}" } }) })
    expect(previewText(renderer)).toMatch(/literal positional placeholder/)
    expect(buttonWithText(renderer, "Save")?.props.disabled).toBe(true)
  })

  it("surfaces a malformed-brace error", () => {
    render([template()])
    act(() => { textareaFor(renderer).props.onChange({ target: { value: "Hi {{{name}}}" } }) })
    expect(previewText(renderer)).toMatch(/malformed placeholder braces/)
    expect(buttonWithText(renderer, "Save")?.props.disabled).toBe(true)
  })

  it("blocks saving on a Meta template name the API would reject", () => {
    render([template()])
    expect(buttonWithText(renderer, "Save")?.props.disabled).toBe(false)
    act(() => {
      inputByLabel(renderer, "Meta template name").props.onChange({ target: { value: "Loan Approved" } })
    })
    expect(buttonWithText(renderer, "Save")?.props.disabled).toBe(true)
    expect(JSON.stringify(renderer.toJSON())).toContain("only lowercase letters")
  })

  it("blocks saving on a malformed language code", () => {
    render([template()])
    act(() => { inputByLabel(renderer, "Language").props.onChange({ target: { value: "en-GB" } }) })
    expect(buttonWithText(renderer, "Save")?.props.disabled).toBe(true)
    expect(JSON.stringify(renderer.toJSON())).toContain("Meta locale code")
  })

  // Split deliberately: clearing the selector resets EVERY field at once, so a
  // single "new template is blocked" test cannot tell which guard fired and
  // would still pass if only one of them existed.
  /** Start from "+ New template" (the only state where the event key is
   * editable) and fill everything except the named field. */
  function newTemplateMissing(field: "event" | "body") {
    render([template()])
    // The template <select> was replaced by WabaTemplateList, so "start a new
    // template" is now its "+ New template" button rather than the empty option.
    act(() => { buttonWithText(renderer, "New template")!.props.onClick() })
    act(() => {
      inputByLabel(renderer, "Meta template name").props.onChange({ target: { value: "new_tpl" } })
    })
    if (field !== "event") {
      act(() => { inputByLabel(renderer, "Event key").props.onChange({ target: { value: "new_tpl" } }) })
    }
    if (field !== "body") {
      act(() => { textareaFor(renderer).props.onChange({ target: { value: "Hello {{firstName}}" } }) })
    }
  }

  it("blocks saving when the event key alone is missing", () => {
    newTemplateMissing("event")
    expect(buttonWithText(renderer, "Save")?.props.disabled).toBe(true)
  })

  it("blocks saving when the body alone is missing", () => {
    newTemplateMissing("body")
    expect(buttonWithText(renderer, "Save")?.props.disabled).toBe(true)
  })

  it("allows saving once every required field is present", () => {
    render([template()])
    // The template <select> was replaced by WabaTemplateList, so "start a new
    // template" is now its "+ New template" button rather than the empty option.
    act(() => { buttonWithText(renderer, "New template")!.props.onClick() })
    act(() => { inputByLabel(renderer, "Meta template name").props.onChange({ target: { value: "new_tpl" } }) })
    act(() => { inputByLabel(renderer, "Event key").props.onChange({ target: { value: "new_tpl" } }) })
    act(() => { textareaFor(renderer).props.onChange({ target: { value: "Hello {{firstName}}" } }) })
    expect(buttonWithText(renderer, "Save")?.props.disabled).toBe(false)
  })

  it("blocks saving when the Meta template name alone is missing", () => {
    render([template()])
    act(() => { inputByLabel(renderer, "Meta template name").props.onChange({ target: { value: "" } }) })
    expect(buttonWithText(renderer, "Save")?.props.disabled).toBe(true)
    expect(JSON.stringify(renderer.toJSON())).toContain("required")
  })
})

describe("stored rows this editor cannot round-trip", () => {
  // Showing "no buttons" and then saving null would destroy the stored value.
  it("blocks editing a template whose stored buttons are not a list", () => {
    render([template({ buttons: { type: "QUICK_REPLY", text: "Yes" } })])
    expect(buttonWithText(renderer, "Save")?.props.disabled).toBe(true)
    expect(JSON.stringify(renderer.toJSON())).toContain("not a list")
  })

  // Silently rendering MARKETING as SERVICE would downgrade the lawful basis.
  it("blocks editing a MARKETING template rather than downgrading its category", () => {
    render([template({ category: "MARKETING" })])
    expect(buttonWithText(renderer, "Save")?.props.disabled).toBe(true)
    expect(JSON.stringify(renderer.toJSON())).toContain("consent basis")
  })

  it("defaults a category-less template to SERVICE, not to the permissive lane", () => {
    render([template({ category: null })])
    expect(inputByLabel(renderer, "Category").props.value).toBe("SERVICE")
    expect(buttonWithText(renderer, "Save")?.props.disabled).toBe(false)
  })
})

describe("provider state", () => {
  it("shows the Meta status and provider template id", () => {
    render([template({ providerStatus: "PENDING", providerTemplateId: "meta-123" })])
    const json = JSON.stringify(renderer.toJSON())
    expect(json).toContain("PENDING")
    expect(json).toContain("meta-123")
  })

  it("shows NOT SUBMITTED for a template Meta has never seen", () => {
    render([template()])
    expect(JSON.stringify(renderer.toJSON())).toContain("NOT SUBMITTED")
  })
})

describe("save", () => {
  function stubFetch(response: unknown, ok = true) {
    const fetchMock = vi.fn().mockResolvedValue({
      ok, status: ok ? 200 : 400, json: async () => response,
    })
    vi.stubGlobal("fetch", fetchMock)
    return fetchMock
  }

  it("PUTs the buttons in the stored contract shape, with no stray keys", async () => {
    const withButtons = template({
      buttons: [
        { type: "QUICK_REPLY", text: "Yes" },
        { type: "URL", text: "Pay", url: "https://acme-lending.example/pay/{{ref}}" },
        { type: "PHONE_NUMBER", text: "Call", phoneNumber: "27110000000" },
      ],
    })
    const fetchMock = stubFetch({ template: withButtons, submit: { attempted: true, ok: true } })
    render([withButtons])

    await act(async () => { await buttonWithText(renderer, "Save")?.props.onClick() })

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("/api/settings/notifications/waba")
    expect(init.method).toBe("PUT")
    expect(JSON.parse(init.body).buttons).toEqual([
      { type: "QUICK_REPLY", text: "Yes" },
      { type: "URL", text: "Pay", url: "https://acme-lending.example/pay/{{ref}}" },
      { type: "PHONE_NUMBER", text: "Call", phoneNumber: "27110000000" },
    ])
  })

  it("sends the category that selects the consent lane", async () => {
    const fetchMock = stubFetch({ template: template(), submit: { attempted: true, ok: true } })
    render([template({ category: "TRANSACTIONAL" })])
    await act(async () => { await buttonWithText(renderer, "Save")?.props.onClick() })
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).category).toBe("TRANSACTIONAL")
  })

  it("warns that a new template reusing an existing event key will replace it", () => {
    render([template({ event: "loan_approved" })])
    // The template <select> was replaced by WabaTemplateList, so "start a new
    // template" is now its "+ New template" button rather than the empty option.
    act(() => { buttonWithText(renderer, "New template")!.props.onClick() })
    expect(JSON.stringify(renderer.toJSON())).not.toContain("Saving REPLACES it")
    act(() => { inputByLabel(renderer, "Event key").props.onChange({ target: { value: "loan_approved" } }) })
    expect(JSON.stringify(renderer.toJSON())).toContain("Saving REPLACES it")
  })

  it("sends null rather than an empty array when there are no buttons", async () => {
    const fetchMock = stubFetch({ template: template(), submit: { attempted: false, ok: false } })
    render([template()])
    await act(async () => { await buttonWithText(renderer, "Save")?.props.onClick() })
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).buttons).toBeNull()
  })

  it("tells the operator when Meta rejected the submission but the save held", async () => {
    stubFetch({
      template: template(),
      submit: { attempted: true, ok: false, error: "template create 400: name already exists" },
    })
    render([template()])
    await act(async () => { await buttonWithText(renderer, "Save")?.props.onClick() })
    expect(JSON.stringify(renderer.toJSON())).toContain("name already exists")
  })

  it("surfaces a 400 from the write path", async () => {
    stubFetch({ error: "wabaTemplateName may contain only lowercase letters, digits and underscores" }, false)
    render([template()])
    await act(async () => { await buttonWithText(renderer, "Save")?.props.onClick() })
    expect(JSON.stringify(renderer.toJSON())).toContain("only lowercase letters")
  })

  it("reflects the post-submit provider status returned by the write path", async () => {
    stubFetch({
      template: template({ providerStatus: "PENDING", providerTemplateId: "meta-777" }),
      submit: { attempted: true, ok: true },
    })
    render([template()])
    await act(async () => { await buttonWithText(renderer, "Save")?.props.onClick() })
    const json = JSON.stringify(renderer.toJSON())
    expect(json).toContain("meta-777")
    expect(json).toContain("submitted to Meta for approval")
  })
})
