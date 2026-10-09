import { describe, it, expect } from "vitest"
import {
  extractPlaceholders, buildTemplateComponents, extractButtonPlaceholders,
} from "./template-components"
import { buildButtonsComponent } from "./template-buttons"

describe("extractButtonPlaceholders", () => {
  it("returns the variable names used by URL buttons", () => {
    expect(extractButtonPlaceholders([
      { type: "QUICK_REPLY", text: "Yes" },
      { type: "URL", text: "View", url: "https://x.co.za/loans/{{loanId}}" },
    ])).toEqual(["loanId"])
  })

  it("returns [] for buttons with no variables, or for junk", () => {
    expect(extractButtonPlaceholders([{ type: "URL", text: "View", url: "https://x.co.za/a" }])).toEqual([])
    expect(extractButtonPlaceholders(null)).toEqual([])
    expect(extractButtonPlaceholders("nonsense")).toEqual([])
    expect(extractButtonPlaceholders([null, 7])).toEqual([])
  })
})

describe("buildTemplateComponents — button parameters", () => {
  const buttons = [
    { type: "QUICK_REPLY", text: "Yes" },
    { type: "URL", text: "View", url: "https://x.co.za/loans/{{loanId}}" },
  ]

  it("emits a button component carrying the URL variable's value", () => {
    const built = buildTemplateComponents(
      { bodyTemplate: "Hi {{name}}", headerContent: null, buttons },
      { name: "Thabo", loanId: "LN12345" },
    )
    expect(built).toContainEqual({
      type: "button", sub_type: "url", index: "1",
      parameters: [{ type: "text", text: "LN12345" }],
    })
  })

  it("indexes the button by its position in the buttons array", () => {
    const built = buildTemplateComponents(
      { bodyTemplate: "Hi {{name}}", headerContent: null, buttons: [buttons[1]] },
      { name: "Thabo", loanId: "LN1" },
    )
    expect(built.find((c) => c.type === "button")).toMatchObject({ index: "0" })
  })

  // send.ts's blank check trims, so the shipped value must trim too — else
  // "  LN123  " passes the check and ships as %20%20LN123%20%20, baking the
  // padding into the borrower's link.
  it("trims the value, matching the blank check that gates it", () => {
    const built = buildTemplateComponents(
      { bodyTemplate: "Hi", headerContent: null, buttons: [buttons[1]] },
      { loanId: "  LN123  " },
    )
    expect(built.find((c) => c.type === "button")).toMatchObject({
      parameters: [{ type: "text", text: "LN123" }],
    })
  })

  it("percent-encodes the value, which Meta appends to the url", () => {
    const built = buildTemplateComponents(
      { bodyTemplate: "Hi", headerContent: null, buttons: [buttons[1]] },
      { loanId: "Gonçalves & co" },
    )
    expect(built.find((c) => c.type === "button")).toMatchObject({
      parameters: [{ type: "text", text: "Gon%C3%A7alves%20%26%20co" }],
    })
  })

  it("emits no button component when no URL button has a variable", () => {
    const built = buildTemplateComponents(
      { bodyTemplate: "Hi {{name}}", headerContent: null, buttons: [{ type: "URL", text: "V", url: "https://x.co.za/a" }] },
      { name: "Thabo" },
    )
    expect(built.some((c) => c.type === "button")).toBe(false)
  })

  it("stays backward compatible when no buttons are passed", () => {
    expect(buildTemplateComponents({ bodyTemplate: "Hi {{name}}", headerContent: null }, { name: "T" }))
      .toEqual([{ type: "body", parameters: [{ type: "text", text: "T" }] }])
  })

  // Drift guard: CREATE declares example values, SEND supplies parameters. If
  // the counts disagree Meta rejects the send, or renders the approval-time
  // example to a real borrower.
  it("supplies exactly as many button parameters as CREATE declares examples", () => {
    const created = buildButtonsComponent(buttons)!
    const declared = created.buttons.filter((b) => b.type === "URL" && b.example).length
    const supplied = buildTemplateComponents(
      { bodyTemplate: "Hi", headerContent: null, buttons },
      { loanId: "LN1" },
    ).filter((c) => c.type === "button").length
    expect(supplied).toBe(declared)
  })

  // The guard above only exercises a well-formed fixture, so it cannot catch
  // SEND becoming MORE permissive than CREATE. These pin the other direction:
  // for every shape CREATE refuses, SEND must emit nothing rather than a
  // parameter for a template Meta never approved in that shape.
  const CREATE_REJECTS: Array<[string, unknown]> = [
    ["a repeated variable", [{ type: "URL", text: "V", url: "https://x.co.za/{{a}}?b={{a}}" }]],
    ["two variables in one url", [{ type: "URL", text: "V", url: "https://x.co.za/{{a}}/{{b}}" }]],
    ["a variable not at the end", [{ type: "URL", text: "V", url: "https://x.co.za/{{a}}/stmt" }]],
    ["a literal positional", [{ type: "URL", text: "V", url: "https://x.co.za/{{1}}" }]],
    ["more URL buttons than Meta allows", [
      { type: "URL", text: "A", url: "https://x.co.za/{{a}}" },
      { type: "URL", text: "B", url: "https://x.co.za/{{b}}" },
      { type: "URL", text: "C", url: "https://x.co.za/{{c}}" },
    ]],
    ["a non-array buttons value", JSON.stringify([{ type: "URL", text: "V", url: "https://x.co.za/{{a}}" }])],
    ["a junk element", [null, { type: "URL", text: "V", url: "https://x.co.za/{{a}}" }]],
  ]

  it.each(CREATE_REJECTS)("emits no button parameter for %s, which CREATE rejects", (_label, stored) => {
    expect(() => buildButtonsComponent(stored)).toThrow()
    const supplied = buildTemplateComponents(
      { bodyTemplate: "Hi", headerContent: null, buttons: stored },
      { a: "A", b: "B", c: "C", "1": "X" },
    ).filter((c) => c.type === "button")
    expect(supplied).toEqual([])
  })
})

describe("extractPlaceholders", () => {
  it("returns placeholder names in first-seen order, de-duplicated", () => {
    expect(extractPlaceholders("Hi {{name}}, your ref {{ref}} — thanks {{name}}"))
      .toEqual(["name", "ref"])
  })
  it("returns [] when there are none", () => {
    expect(extractPlaceholders("no vars here")).toEqual([])
  })
})

describe("buildTemplateComponents", () => {
  it("maps body placeholders to ordered body text parameters", () => {
    expect(buildTemplateComponents(
      { bodyTemplate: "Hi {{name}}, ref {{ref}}", headerContent: null },
      { name: "Thabo", ref: "L-123" },
    )).toEqual([
      { type: "body", parameters: [{ type: "text", text: "Thabo" }, { type: "text", text: "L-123" }] },
    ])
  })
  it("adds a header component when headerContent has a placeholder", () => {
    expect(buildTemplateComponents(
      { bodyTemplate: "Body {{ref}}", headerContent: "Hello {{name}}" },
      { name: "Thabo", ref: "L-123" },
    )).toEqual([
      { type: "header", parameters: [{ type: "text", text: "Thabo" }] },
      { type: "body", parameters: [{ type: "text", text: "L-123" }] },
    ])
  })
  it("omits a component with no placeholders", () => {
    expect(buildTemplateComponents({ bodyTemplate: "static body", headerContent: null }, {}))
      .toEqual([])
  })
})
