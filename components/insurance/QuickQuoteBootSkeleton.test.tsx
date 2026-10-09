import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * The skeleton shows REAL words while the widget boots — the step titles, the
 * heading, "Step 1 of 4", and every field label. `aria-hidden` keeps them out
 * of the accessibility tree; it does nothing about the person looking at them,
 * so WCAG 1.4.3 applies exactly as it would to any other text.
 *
 * They were failing it. Measured on the rendered page: "Step 1 of 4" at
 * 2.28:1 and "Year of birth" at 2.39:1 against a 4.5:1 floor, "About you" at
 * 3.87:1 against the same. Only the 28px heading cleared, and only because
 * large text is allowed 3:1.
 *
 * The cause was a group opacity — `.cf-wiz-skeleton { opacity: 0.55 }` — with
 * a companion rule "lifting" the text classes back to 0.72. Nested opacity
 * MULTIPLIES: a child is drawn into its group and cannot come out less
 * transparent than the group is. So the lift delivered 0.55 x 0.72 = 0.396 and
 * left those words dimmer than doing nothing would have, while its comment
 * said they were "real and legible".
 *
 * That is why this file tests a STRUCTURE rather than a number. The failure was
 * invisible in every place anyone would look: the CSS says 0.72, the element
 * says 0.72, `getComputedStyle` says 0.72, and the painted pixel says 0.396.
 * Only compositing the layers by hand reveals it. Forbidding the mechanism is
 * checkable; asking people to remember how opacity nests is not.
 */

const THEME = join(process.cwd(), "app/(quote)/quickquote-theme.css")

/**
 * Preludes are split on commas rather than matched whole, because the rule that
 * caused this bug grouped three selectors:
 *
 *     .cf-wiz-skeleton .cf-wiz-heading,
 *     .cf-wiz-skeleton .cf-wiz-count,
 *     .cf-wiz-skeleton .cf-wiz-steplabel { opacity: 0.72 }
 *
 * A matcher anchored on `<selector> {` only ever sees the LAST member. The
 * first draft of this file did exactly that, and when the broken rules were
 * restored to check it, it reported steplabel and passed heading and count —
 * a guard that finds one third of the thing it is guarding against.
 */
/** Drops functional pseudo-class arguments: `:not(.x)` must not read as `.x`. */
function withoutPseudoArgs(segment: string): string {
  let out = segment
  let previous: string
  do {
    previous = out
    out = out.replace(/:[a-z-]+\([^()]*\)/gi, "")
  } while (out !== previous)
  return out
}

function selectorMentionsClass(segment: string, className: string): boolean {
  /* A class token, not a substring — so `.cf-wiz.cf-wiz-skeleton` and
     `.cf-wiz-skeleton .x` both count while `.cf-wiz-skeleton-foo` does not.
     Exact-string comparison missed the compound form, which is the idiomatic
     way to write this element's own selector: its className really is
     "cf-wiz cf-wiz-skeleton", so `.cf-wiz.cf-wiz-skeleton { opacity }`
     would have reintroduced the whole bug with the guard still green. */
  return new RegExp(`\\.${className}(?![-\\w])`).test(withoutPseudoArgs(segment))
}

/* `filter: opacity(55%)` dims exactly as the property does and never matches
   `opacity:`. Verified: it reproduces the original defect with the earlier
   version of this file fully green. */
const declaresOpacity = (body: string) =>
  /(^|;)\s*opacity\s*:/.test(body) || /(^|;)\s*filter\s*:[^;]*opacity\s*\(/.test(body)

/** The last compound in a segment — what the rule actually targets. */
function targets(segment: string, className: string): boolean {
  const compounds = segment.split(/\s*[>+~]\s*|\s+/).filter(Boolean)
  const last = compounds[compounds.length - 1] ?? ""
  return selectorMentionsClass(last, className)
}

/** Rule bodies whose prelude targets this class, compound forms included. */
function bodiesTargeting(css: string, className: string): string[] {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, "")
  const bodies: string[] = []
  for (const [, prelude, body] of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    for (const segment of prelude.split(",")) {
      if (targets(segment.trim(), className)) {
        bodies.push(body)
        break
      }
    }
  }
  return bodies
}

/** The terminal opacity of a named @keyframes, or null if it sets none. */
function terminalOpacity(css: string, animationName: string): string | null {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, "")
  /* Braces counted rather than terminated on `\n}`. The first version keyed on
     the closing brace sitting unindented at the start of a line, so reformatting
     the sheet — a prettier run, or minification — made it find nothing and fail
     a stylesheet that was perfectly correct. A guard that breaks when the file
     is reformatted teaches people to delete it. */
  const open = source.search(new RegExp(`@keyframes\\s+${animationName}\\s*\\{`))
  if (open === -1) return null
  let depth = 0
  let end = -1
  for (let i = source.indexOf("{", open); i < source.length; i++) {
    if (source[i] === "{") depth++
    else if (source[i] === "}" && --depth === 0) {
      end = i
      break
    }
  }
  if (end === -1) return null

  const block = source.slice(source.indexOf("{", open) + 1, end)
  const last = block.match(/(?:to|100%)\s*\{([^}]*)\}/)
  if (!last) return null
  const opacity = last[1].match(/opacity\s*:\s*([^;]+)/)
  return opacity ? opacity[1].trim() : null
}

describe("the boot skeleton must not dim its own words", () => {
  const css = () => readFileSync(THEME, "utf8")

  /* The group opacity itself. Everything below it inherits the multiplication,
     including text nobody thought about when the value was chosen. */
  it("puts no group opacity on the skeleton root", () => {
    const offenders = bodiesTargeting(css(), "cf-wiz-skeleton").filter(declaresOpacity)
    expect(
      offenders,
      `A rule targets the skeleton root with an opacity. Every word inside it — ` +
        `the step titles, the heading, the field labels — is multiplied by that ` +
        `value, and no child rule can undo it. Recede the placeholders instead.`,
    ).toEqual([])
  })

  /* The "lift" that cannot lift. Its presence is the tell that someone has
     reached for a group opacity again and is trying to exempt the text. */
  it.each(["cf-wiz-heading", "cf-wiz-count", "cf-wiz-steplabel", "cf-skel-label"])(
    "sets no opacity on .%s",
    (className) => {
      const offenders = bodiesTargeting(css(), className).filter(declaresOpacity)
      expect(
        offenders,
        `.${className} is given an opacity. Inside the skeleton's group this ` +
          `MULTIPLIES rather than overrides — the previous attempt at exactly ` +
          `this made the words dimmer than leaving them alone. If it needs to ` +
          `sit back, change its colour.`,
      ).toEqual([])
    },
  )

  /* Recession still has to come from somewhere, or the skeleton reads as the
     finished form and the swap becomes a repaint. It comes from the parts with
     no words in them — which is also the truer signal, since what says "not
     yet" is an empty outline where a control belongs. */
  it("recedes the placeholders, which carry no text", () => {
    const receded = bodiesTargeting(css(), "cf-skel-input").filter(declaresOpacity)
    expect(receded.length, "the skeleton no longer recedes anything at all").toBeGreaterThan(0)
  })

  /* The one a structural test nearly missed. `.cf-skel-input` carries
     `animation: cf-skel-settle ... both`, and `both` includes forwards, so the
     final keyframe keeps applying once the 520ms is up. An animation-origin
     declaration outranks a normal author one, so a plain `opacity` rule on the
     same selector is ignored from that moment on. The first version of this fix
     wrote `opacity: 0.45` there and shipped placeholders that rendered at FULL
     strength — getComputedStyle read back 1 — while this file was green,
     because a rule existing is not a rule applying. */
  it("does not let the settle animation undo the recession", () => {
    const terminal = terminalOpacity(css(), "cf-skel-settle")
    expect(terminal, "@keyframes cf-skel-settle sets no terminal opacity").not.toBeNull()
    expect(
      terminal,
      `cf-skel-settle ends at ${terminal}, which overrides the static ` +
        `recede rule on .cf-skel-input and .cf-skel-button for every visitor ` +
        `who is not on prefers-reduced-motion. The keyframe must land on the ` +
        `same token the static rule uses.`,
    ).toContain("--cf-skel-recede")
  })
})
