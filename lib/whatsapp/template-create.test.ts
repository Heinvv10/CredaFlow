import { describe, it, expect } from "vitest"
import { buildTemplateCreateComponents, toPositionalText, templateNameProblem, templateLanguageProblem } from "./template-create"
import { buildTemplateComponents } from "./template-components"

describe("toPositionalText", () => {
  it("renumbers named placeholders to Meta's positional {{n}} form", () => {
    expect(toPositionalText("Hi {{name}}, ref {{ref}}")).toEqual({
      text: "Hi {{1}}, ref {{2}}",
      names: ["name", "ref"],
    })
  })

  it("reuses one index for a repeated placeholder", () => {
    expect(toPositionalText("Hi {{name}} — bye {{name}}")).toEqual({
      text: "Hi {{1}} — bye {{1}}",
      names: ["name"],
    })
  })

  it("leaves text without placeholders untouched", () => {
    expect(toPositionalText("no vars here")).toEqual({ text: "no vars here", names: [] })
  })

  // The PLACEHOLDER regex is /g and shared with template-components.ts, where
  // it is also used by matchAll. A leaked lastIndex would make the second call
  // on the same input skip the first placeholder.
  it("is stable across repeated calls on the same input", () => {
    const text = "Hi {{name}}, ref {{ref}}"
    const first = toPositionalText(text)
    expect(toPositionalText(text)).toEqual(first)
    expect(toPositionalText(text)).toEqual(first)
  })

  it("handles adjacent placeholders", () => {
    expect(toPositionalText("{{a}}{{b}}").text).toBe("{{1}}{{2}}")
  })

  it("tolerates whitespace inside the braces", () => {
    expect(toPositionalText("Hi {{ name }}")).toEqual({ text: "Hi {{1}}", names: ["name"] })
  })

  it("does not conflate a name that is a prefix of another", () => {
    expect(toPositionalText("{{name}} vs {{names}}")).toEqual({
      text: "{{1}} vs {{2}}", names: ["name", "names"],
    })
  })

  it("numbers past nine variables", () => {
    const source = Array.from({ length: 11 }, (_, i) => `{{v${i}}}`).join(" ")
    expect(toPositionalText(source).text).toContain("{{11}}")
  })

  it("is idempotent on already-positional text", () => {
    const once = toPositionalText("Hi {{name}}, ref {{ref}}").text
    expect(toPositionalText(once).text).toBe(once)
  })
})

describe("buildTemplateCreateComponents", () => {
  it("builds the BODY definition shape Meta documents (uppercase type, text, example)", () => {
    expect(buildTemplateCreateComponents({
      bodyTemplate: "Hi {{name}}, ref {{ref}}", headerContent: null, footer: null,
    })).toEqual([
      { type: "BODY", text: "Hi {{1}}, ref {{2}}", example: { body_text: [["name", "ref"]] } },
    ])
  })

  it("omits example when the body has no variables", () => {
    expect(buildTemplateCreateComponents({
      bodyTemplate: "Your loan is approved.", headerContent: null, footer: null,
    })).toEqual([{ type: "BODY", text: "Your loan is approved." }])
  })

  it("emits HEADER first with format TEXT and a flat header_text example", () => {
    expect(buildTemplateCreateComponents({
      bodyTemplate: "Body {{ref}}", headerContent: "Hello {{name}}", footer: null,
    })).toEqual([
      { type: "HEADER", format: "TEXT", text: "Hello {{1}}", example: { header_text: ["name"] } },
      { type: "BODY", text: "Body {{1}}", example: { body_text: [["ref"]] } },
    ])
  })

  it("emits FOOTER after BODY", () => {
    expect(buildTemplateCreateComponents({
      bodyTemplate: "Body", headerContent: null, footer: "Acme Lending",
    })).toEqual([
      { type: "BODY", text: "Body" },
      { type: "FOOTER", text: "Acme Lending" },
    ])
  })

  it("emits BUTTONS last, after FOOTER", () => {
    expect(buildTemplateCreateComponents({
      bodyTemplate: "Body", headerContent: null, footer: "Acme Lending",
      buttons: [{ type: "QUICK_REPLY", text: "Yes" }],
    })).toEqual([
      { type: "BODY", text: "Body" },
      { type: "FOOTER", text: "Acme Lending" },
      { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Yes" }] },
    ])
  })

  it("omits BUTTONS when there are none", () => {
    const built = buildTemplateCreateComponents({
      bodyTemplate: "Body", headerContent: null, footer: null, buttons: [],
    })
    expect(built.some((c) => c.type === "BUTTONS")).toBe(false)
  })

  // A digit-only name means an operator typed a literal {{1}} into the body.
  // The shared regex accepts it as a name, so it would silently become a real
  // variable needing a send-time value keyed "1" — which nothing supplies.
  it("rejects a literal positional placeholder in stored text", () => {
    expect(() => buildTemplateCreateComponents({
      bodyTemplate: "Hi {{name}}, ref {{1}}", headerContent: null, footer: null,
    })).toThrow(/\{\{1\}\}|positional|literal/i)
  })

  // {{{a}}} renders as {value} to the borrower — the regex matches the inner
  // {{a}} and leaves the outer braces as literal text.
  it("rejects malformed placeholder braces in the body", () => {
    expect(() => buildTemplateCreateComponents({
      bodyTemplate: "Hi {{{name}}}", headerContent: null, footer: null,
    })).toThrow(/brace|malformed/i)
  })

  it("rejects an unclosed placeholder in the body", () => {
    expect(() => buildTemplateCreateComponents({
      bodyTemplate: "Hi {{name}", headerContent: null, footer: null,
    })).toThrow(/unclosed placeholder/i)
  })

  // Only an ATTEMPTED placeholder is malformed. A stray double-brace in prose
  // is literal text the author meant, and rejecting it blocks a valid template.
  it("allows a stray double-brace in ordinary prose", () => {
    expect(() => buildTemplateCreateComponents({
      bodyTemplate: "Reply STOP or use }} to close your account", headerContent: null, footer: null,
    })).not.toThrow()
    expect(() => buildTemplateCreateComponents({
      bodyTemplate: "Here is {{ for info, ignore it", headerContent: null, footer: null,
    })).not.toThrow()
  })

  it("rejects malformed placeholder braces in the header", () => {
    expect(() => buildTemplateCreateComponents({
      bodyTemplate: "Body", headerContent: "Hi {{{name}}}", footer: null,
    })).toThrow(/brace|malformed/i)
  })

  it("rejects a literal positional placeholder in the header", () => {
    expect(() => buildTemplateCreateComponents({
      bodyTemplate: "Body", headerContent: "Update {{2}}", footer: null,
    })).toThrow(/positional|literal|\{\{2\}\}/i)
  })

  it("never emits the send-time shape (lowercase type / parameters array)", () => {
    const built = buildTemplateCreateComponents({
      bodyTemplate: "Hi {{name}}", headerContent: "Hdr {{name}}", footer: "f",
    })
    for (const c of built) {
      expect(c.type).toBe(c.type.toUpperCase())
      expect(c).not.toHaveProperty("parameters")
    }
  })

  it("rejects a blank body — Meta requires a BODY component", () => {
    expect(() => buildTemplateCreateComponents({ bodyTemplate: null, headerContent: null, footer: null }))
      .toThrow(/body/i)
    expect(() => buildTemplateCreateComponents({ bodyTemplate: "   ", headerContent: null, footer: null }))
      .toThrow(/body/i)
  })

  it("rejects a TEXT header with more than one variable (Meta allows exactly one)", () => {
    expect(() => buildTemplateCreateComponents({
      bodyTemplate: "b", headerContent: "{{a}} and {{b}}", footer: null,
    })).toThrow(/header/i)
  })

  it("rejects a footer containing a variable (Meta footers take no parameters)", () => {
    expect(() => buildTemplateCreateComponents({
      bodyTemplate: "b", headerContent: null, footer: "Ref {{ref}}",
    })).toThrow(/footer/i)
  })

  // Drift guard: the CREATE example count and the SEND parameter count are
  // derived independently. If they disagree, Meta rejects the send at runtime
  // with a parameter-count mismatch — the exact failure this pairing prevents.
  it("declares exactly as many body variables as the send-time builder supplies", () => {
    const stored = { bodyTemplate: "Hi {{name}}, ref {{ref}} — thanks {{name}}", headerContent: null }
    const created = buildTemplateCreateComponents({ ...stored, footer: null })
    const sent = buildTemplateComponents(stored, { name: "Thabo", ref: "L-123" })

    const createdBody = created.find((c) => c.type === "BODY")
    const sentBody = sent.find((c) => c.type === "body")
    expect(createdBody).toBeDefined()
    expect(sentBody).toBeDefined()
    const declared = createdBody!.type === "BODY" ? createdBody!.example?.body_text[0].length ?? 0 : 0
    expect(declared).toBe(sentBody!.parameters.length)
  })
})

describe("templateNameProblem", () => {
  it("accepts Meta's documented name shape", () => {
    expect(templateNameProblem("loan_approved_v2")).toBeNull()
    expect(templateNameProblem("reminder3")).toBeNull()
  })

  it("rejects uppercase, spaces, hyphens and other punctuation", () => {
    expect(templateNameProblem("Loan_Approved")).toMatch(/lowercase/)
    expect(templateNameProblem("loan approved")).toMatch(/lowercase/)
    expect(templateNameProblem("loan-approved")).toMatch(/lowercase/)
    expect(templateNameProblem("loan.approved")).toMatch(/lowercase/)
  })

  it("rejects an empty or whitespace-only name", () => {
    expect(templateNameProblem("")).toMatch(/required/)
    expect(templateNameProblem("   ")).toMatch(/required/)
  })

  it("counts the trimmed name against Meta's 512-character cap", () => {
    expect(templateNameProblem(`  ${"a".repeat(512)}  `)).toBeNull()
    expect(templateNameProblem("a".repeat(513))).toMatch(/513 characters/)
  })
})

describe("templateLanguageProblem", () => {
  it("accepts Meta locale codes", () => {
    for (const code of ["en", "af", "zu", "fil", "en_GB", "pt_BR", "zh_CN"]) {
      expect(templateLanguageProblem(code)).toBeNull()
    }
  })

  it("rejects an empty or malformed locale", () => {
    expect(templateLanguageProblem("")).toMatch(/required/)
    expect(templateLanguageProblem("English")).toMatch(/locale/)
    expect(templateLanguageProblem("en-GB")).toMatch(/locale/)
    expect(templateLanguageProblem("en_gb")).toMatch(/locale/)
  })
})

describe("Meta text length caps", () => {
  it("rejects a body over 1024 characters", () => {
    expect(() => buildTemplateCreateComponents({
      bodyTemplate: "x".repeat(1025), headerContent: null, footer: null,
    })).toThrow(/body is 1025 characters/)
  })

  it("accepts a body at exactly 1024 characters", () => {
    expect(() => buildTemplateCreateComponents({
      bodyTemplate: "x".repeat(1024), headerContent: null, footer: null,
    })).not.toThrow()
  })

  it("rejects a header over 60 characters", () => {
    expect(() => buildTemplateCreateComponents({
      bodyTemplate: "b", headerContent: "x".repeat(61), footer: null,
    })).toThrow(/header is 61 characters/)
  })

  it("rejects a footer over 60 characters", () => {
    expect(() => buildTemplateCreateComponents({
      bodyTemplate: "b", headerContent: null, footer: "x".repeat(61),
    })).toThrow(/footer is 61 characters/)
  })

  // Meta counts what the borrower sees. The positional form is shorter than the
  // authored text ({{firstName}} → {{1}}), so measuring the authored string
  // would reject templates Meta would accept.
  it("measures the positional text Meta receives, not the authored placeholders", () => {
    const body = `${"x".repeat(1010)} {{aVeryLongPlaceholderName}}`
    expect(body.length).toBeGreaterThan(1024)
    expect(() => buildTemplateCreateComponents({
      bodyTemplate: body, headerContent: null, footer: null,
    })).not.toThrow()
  })
})
