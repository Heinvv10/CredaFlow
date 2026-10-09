import { describe, it, expect } from "vitest"
import { buildButtonsComponent } from "./template-buttons"

describe("buildButtonsComponent", () => {
  it("returns null when there are no buttons", () => {
    expect(buildButtonsComponent(null)).toBeNull()
    expect(buildButtonsComponent(undefined)).toBeNull()
    expect(buildButtonsComponent([])).toBeNull()
  })

  it("builds quick-reply buttons in Meta's shape", () => {
    expect(buildButtonsComponent([
      { type: "QUICK_REPLY", text: "Yes, arrange payment" },
      { type: "QUICK_REPLY", text: "Not now" },
    ])).toEqual({
      type: "BUTTONS",
      buttons: [
        { type: "QUICK_REPLY", text: "Yes, arrange payment" },
        { type: "QUICK_REPLY", text: "Not now" },
      ],
    })
  })

  it("builds a static URL button without an example", () => {
    expect(buildButtonsComponent([
      { type: "URL", text: "View statement", url: "https://portal.example.co.za/loans" },
    ])).toEqual({
      type: "BUTTONS",
      buttons: [{ type: "URL", text: "View statement", url: "https://portal.example.co.za/loans" }],
    })
  })

  it("renumbers a trailing URL variable to {{1}} and carries its example value", () => {
    expect(buildButtonsComponent([
      { type: "URL", text: "View statement", url: "https://portal.example.co.za/loans/{{loanId}}" },
    ])).toEqual({
      type: "BUTTONS",
      buttons: [{
        type: "URL", text: "View statement",
        url: "https://portal.example.co.za/loans/{{1}}",
        example: ["loanId"],
      }],
    })
  })

  it("accepts a variable at the end of a query string", () => {
    const built = buildButtonsComponent([
      { type: "URL", text: "View", url: "https://x.co.za/s?ref={{ref}}" },
    ])
    expect(built!.buttons[0]).toEqual({
      type: "URL", text: "View", url: "https://x.co.za/s?ref={{1}}", example: ["ref"],
    })
  })

  it("rejects a literal positional placeholder in a URL", () => {
    expect(() => buildButtonsComponent([
      { type: "URL", text: "View", url: "https://x.co.za/{{1}}" },
    ])).toThrow(/positional|literal/i)
  })

  // Both occurrences render, but the send path supplies one value, and Meta
  // documents a single variable appended to the end.
  it("rejects a repeated variable in a URL", () => {
    expect(() => buildButtonsComponent([
      { type: "URL", text: "View", url: "https://x.co.za/{{a}}?b={{a}}" },
    ])).toThrow(/once|one variable/i)
  })

  it("rejects a variable that is not at the end", () => {
    expect(() => buildButtonsComponent([
      { type: "URL", text: "View", url: "https://x.co.za/{{a}}/statement" },
    ])).toThrow(/end/i)
  })

  it("maps phoneNumber to Meta's snake_case phone_number", () => {
    expect(buildButtonsComponent([
      { type: "PHONE_NUMBER", text: "Call us", phoneNumber: "27110000000" },
    ])).toEqual({
      type: "BUTTONS",
      buttons: [{ type: "PHONE_NUMBER", text: "Call us", phone_number: "27110000000" }],
    })
  })

  it("preserves declaration order across mixed types", () => {
    const built = buildButtonsComponent([
      { type: "QUICK_REPLY", text: "Yes" },
      { type: "QUICK_REPLY", text: "No" },
      { type: "URL", text: "View", url: "https://x.co.za/a" },
      { type: "PHONE_NUMBER", text: "Call", phoneNumber: "27110000000" },
    ])
    expect(built!.buttons.map((b) => b.type)).toEqual(["QUICK_REPLY", "QUICK_REPLY", "URL", "PHONE_NUMBER"])
  })

  describe("rejects what Meta would reject", () => {
    it("a non-array value", () => {
      expect(() => buildButtonsComponent({ type: "QUICK_REPLY", text: "Yes" })).toThrow(/array/i)
      expect(() => buildButtonsComponent("QUICK_REPLY")).toThrow(/array/i)
    })

    it("an unknown button type", () => {
      expect(() => buildButtonsComponent([{ type: "COPY_CODE", text: "Copy" }])).toThrow(/COPY_CODE/)
    })

    it("a null element", () => {
      expect(() => buildButtonsComponent([null])).toThrow(/button/i)
    })

    it("an array masquerading as a button object", () => {
      expect(() => buildButtonsComponent([["QUICK_REPLY", "Yes"]])).toThrow(/expected an object/i)
    })

    it("a hole in a sparse array", () => {
      // Array.from fills holes with undefined; raw.map would skip them entirely.
      const sparse = new Array(2)
      expect(() => buildButtonsComponent(sparse)).toThrow(/expected an object/i)
    })

    it("a non-https url", () => {
      expect(() => buildButtonsComponent([{ type: "URL", text: "View", url: "javascript:alert(1)" }]))
        .toThrow(/https/i)
      expect(() => buildButtonsComponent([{ type: "URL", text: "View", url: "http://x.co.za/a" }]))
        .toThrow(/https/i)
    })

    it("blank or over-long label text (Meta caps at 25)", () => {
      expect(() => buildButtonsComponent([{ type: "QUICK_REPLY", text: "" }])).toThrow(/text/i)
      expect(() => buildButtonsComponent([{ type: "QUICK_REPLY", text: "x".repeat(26) }])).toThrow(/25/)
      expect(buildButtonsComponent([{ type: "QUICK_REPLY", text: "x".repeat(25) }])).not.toBeNull()
    })

    // "25 characters" counted as UTF-16 code units rejected 25 visible
    // characters made of combining marks or non-BMP emoji, which is a false
    // rejection. Count what a reader would call a character.
    it("counts user-perceived characters, not UTF-16 code units", () => {
      // Explicitly DECOMPOSED (e + combining acute) and a non-BMP emoji: both
      // are 2 code units each, so 25 of them measure 50 the old way. A
      // precomposed "é" would be 1 unit and prove nothing here.
      const combining = "é"
      expect(combining.length).toBe(2)
      expect(buildButtonsComponent([{ type: "QUICK_REPLY", text: combining.repeat(25) }])).not.toBeNull()
      expect(buildButtonsComponent([{ type: "QUICK_REPLY", text: "👍".repeat(25) }])).not.toBeNull()
      expect(() => buildButtonsComponent([{ type: "QUICK_REPLY", text: "👍".repeat(26) }])).toThrow(/25/)
    })

    it("a phone number longer than Meta's 20-character cap", () => {
      expect(buildButtonsComponent([
        { type: "PHONE_NUMBER", text: "Call", phoneNumber: "2".repeat(20) },
      ])).not.toBeNull()
      expect(() => buildButtonsComponent([
        { type: "PHONE_NUMBER", text: "Call", phoneNumber: "2".repeat(21) },
      ])).toThrow(/20/)
    })

    it("malformed placeholder braces in a url", () => {
      expect(() => buildButtonsComponent([
        { type: "URL", text: "V", url: "https://x.co.za/{{{ref}}}" },
      ])).toThrow(/brace|malformed/i)
    })

    // The url path must inherit the SAME brace protection as body/header, not
    // just the triple-brace half — an unclosed {{ref registers verbatim.
    it("an unclosed placeholder in a url", () => {
      expect(() => buildButtonsComponent([
        { type: "URL", text: "V", url: "https://x.co.za/loans/{{ref" },
      ])).toThrow(/unclosed placeholder/i)
    })

    it("a stray closing brace pair in a url", () => {
      expect(() => buildButtonsComponent([
        { type: "URL", text: "V", url: "https://x.co.za/loans/ref}}" },
      ])).toThrow(/brace|malformed/i)
    })

    it("more than ten buttons", () => {
      const ten = Array.from({ length: 10 }, (_, i) => ({ type: "QUICK_REPLY", text: `b${i}` }))
      expect(buildButtonsComponent(ten)).not.toBeNull()
      expect(() => buildButtonsComponent([...ten, { type: "QUICK_REPLY", text: "b10" }])).toThrow(/10/)
    })

    it("more than one phone-number button", () => {
      expect(() => buildButtonsComponent([
        { type: "PHONE_NUMBER", text: "Call", phoneNumber: "27110000000" },
        { type: "PHONE_NUMBER", text: "Call 2", phoneNumber: "27110000001" },
      ])).toThrow(/phone/i)
    })

    it("more than two URL buttons", () => {
      expect(() => buildButtonsComponent([
        { type: "URL", text: "A", url: "https://x.co.za/a" },
        { type: "URL", text: "B", url: "https://x.co.za/b" },
        { type: "URL", text: "C", url: "https://x.co.za/c" },
      ])).toThrow(/URL/)
    })

    it("quick-reply buttons interspersed with other types", () => {
      expect(() => buildButtonsComponent([
        { type: "QUICK_REPLY", text: "Yes" },
        { type: "URL", text: "View", url: "https://x.co.za/a" },
        { type: "QUICK_REPLY", text: "No" },
      ])).toThrow(/contiguous|grouped/i)
    })

    it("more than one URL variable", () => {
      expect(() => buildButtonsComponent([
        { type: "URL", text: "View", url: "https://x.co.za/{{a}}/{{b}}" },
      ])).toThrow(/one variable/i)
    })

    it("a blank url or phone number", () => {
      expect(() => buildButtonsComponent([{ type: "URL", text: "View", url: "  " }])).toThrow(/url/i)
      expect(() => buildButtonsComponent([{ type: "PHONE_NUMBER", text: "Call", phoneNumber: "" }]))
        .toThrow(/phone/i)
    })
  })
})
