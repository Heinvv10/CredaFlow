import { extractPlaceholders, toPositionalText, assertNoLiteralPositionals, assertWellFormedPlaceholders } from "./template-components"
import { buildButtonsComponent, type WaButtonsComponent } from "./template-buttons"

// Re-exported so the CREATE-shape surface stays in one place for callers.
export { toPositionalText }

/**
 * A component in Meta's message-template DEFINITION shape — what POST
 * /{waba-id}/message_templates expects. This is NOT the send-time shape
 * (`{type:"body", parameters:[…]}` in template-components.ts): creation
 * declares the template text with positional `{{1}}` variables plus example
 * values, while sending supplies the runtime values for those positions.
 * Mixing the two is silently accepted by neither endpoint.
 */
export type WaTemplateCreateComponent =
  | { type: "HEADER"; format: "TEXT"; text: string; example?: { header_text: string[] } }
  | { type: "BODY"; text: string; example?: { body_text: string[][] } }
  | { type: "FOOTER"; text: string }
  | WaButtonsComponent

/** Meta caps a template name at 512 characters. */
export const MAX_TEMPLATE_NAME = 512

/**
 * The Meta category every Phase 2 template registers under. Marketing-class
 * mapping is deferred (Open item #2). Lives in this prisma-free module so the
 * editor's preview can show the real value — importing it from template-submit
 * would drag prisma into the client bundle, and re-typing it there would let
 * the preview quietly disagree with what is actually submitted.
 */
export const WABA_TEMPLATE_CATEGORY = "UTILITY"

/**
 * Why a WABA template name is unusable, or null if it is fine. Meta documents
 * the `name` field as "only lowercase alphanumeric characters and underscores,
 * maximum 512 characters" — a violation is rejected at CREATE with an opaque
 * Graph error, so it is worth naming precisely.
 *
 * Returns a message rather than throwing because the editor shows it inline
 * while the operator is still typing. ONE definition, imported by both the
 * write path and the editor — a client-side copy would drift.
 */
export function templateNameProblem(name: string): string | null {
  const trimmed = name.trim()
  if (!trimmed) return "is required"
  if (trimmed.length > MAX_TEMPLATE_NAME) {
    return `is ${trimmed.length} characters, Meta allows ${MAX_TEMPLATE_NAME}`
  }
  if (!/^[a-z0-9_]+$/.test(trimmed)) {
    return "may contain only lowercase letters, digits and underscores"
  }
  return null
}

/**
 * Why a template language is unusable, or null if it is fine. Meta's supported
 * languages are locale codes: a 2–3 letter lowercase language, optionally an
 * underscore and a 2-letter uppercase region (`en`, `af`, `fil`, `en_GB`,
 * `zh_CN`). Shape-checked rather than list-checked — Meta adds languages, and
 * an out-of-date allow-list would block a template that would register fine.
 */
export function templateLanguageProblem(language: string): string | null {
  const trimmed = language.trim()
  if (!trimmed) return "is required"
  if (!/^[a-z]{2,3}(_[A-Z]{2})?$/.test(trimmed)) {
    return "must be a Meta locale code such as en, af or en_GB"
  }
  return null
}

/**
 * Builds the `components` array for a template CREATE call from a stored
 * MessageTemplate's WABA columns. Order is Meta's required HEADER → BODY →
 * FOOTER. Example values use the placeholder name, which is what Meta's
 * reviewers see as the sample variable content.
 *
 * Throws rather than emitting a template Meta would reject with an opaque
 * error — a bad definition is cheaper to catch here than in App Review.
 */
// Meta's documented text limits for a template definition. Enforced here, in
// the same place as the button caps, so the editor's preview reports an
// over-long body while it is still editable rather than as a Graph rejection
// the operator has to decode.
const MAX_BODY_TEXT = 1024
const MAX_HEADER_TEXT = 60
const MAX_FOOTER_TEXT = 60

/** Measured on the POSITIONAL text Meta receives, not the authored string:
 * `{{firstName}}` is sent as `{{1}}`, so measuring the source would reject
 * templates that are well within the limit. */
function assertWithinLimit(text: string, limit: number, where: string): void {
  if (text.length > limit) {
    throw new Error(`WABA ${where} is ${text.length} characters, Meta allows ${limit}`)
  }
}

export function buildTemplateCreateComponents(input: {
  bodyTemplate: string | null
  headerContent: string | null
  footer: string | null
  buttons?: unknown
}): WaTemplateCreateComponent[] {
  const out: WaTemplateCreateComponent[] = []

  const header = input.headerContent?.trim()
  if (header) {
    assertWellFormedPlaceholders(header, "header")
    const { text, names } = toPositionalText(header)
    assertNoLiteralPositionals(names, "header")
    // Meta caps a TEXT header at a single variable.
    if (names.length > 1) {
      throw new Error(`WABA header supports at most one variable, found ${names.length}: ${names.join(", ")}`)
    }
    assertWithinLimit(text, MAX_HEADER_TEXT, "header")
    out.push({
      type: "HEADER",
      format: "TEXT",
      text,
      ...(names.length > 0 ? { example: { header_text: names } } : {}),
    })
  }

  const body = input.bodyTemplate?.trim()
  if (!body) throw new Error("WABA template requires a non-empty body")
  assertWellFormedPlaceholders(body, "body")
  const { text: bodyText, names: bodyNames } = toPositionalText(body)
  assertNoLiteralPositionals(bodyNames, "body")
  assertWithinLimit(bodyText, MAX_BODY_TEXT, "body")
  out.push({
    type: "BODY",
    text: bodyText,
    ...(bodyNames.length > 0 ? { example: { body_text: [bodyNames] } } : {}),
  })

  const footer = input.footer?.trim()
  if (footer) {
    // Meta footers are static — a placeholder here would never be substituted.
    if (extractPlaceholders(footer).length > 0) {
      throw new Error("WABA footer cannot contain variables")
    }
    assertWithinLimit(footer, MAX_FOOTER_TEXT, "footer")
    out.push({ type: "FOOTER", text: footer })
  }

  const buttons = buildButtonsComponent(input.buttons)
  if (buttons) out.push(buttons)

  return out
}
