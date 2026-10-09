export type WaTemplateComponent =
  | { type: "body" | "header"; parameters: Array<{ type: "text"; text: string }> }
  /** Meta's send-time URL-button parameter. `index` is the button's position in
   * the template's buttons array, as a string, per Meta's documented example. */
  | { type: "button"; sub_type: "url"; index: string; parameters: Array<{ type: "text"; text: string }> }

/** A ready-to-send WABA template reference (name + language + runtime params). */
export type WaTemplateRef = {
  name: string
  language: string
  components: WaTemplateComponent[]
  providerStatus: string | null
}

/** Shared so the send-time and CREATE-time builders agree on what a
 * placeholder is — two copies could disagree and desync the parameter count. */
export const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g

/** Placeholder names in first-seen order, de-duplicated. */
export function extractPlaceholders(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(PLACEHOLDER)) {
    const name = m[1]
    if (!out.includes(name)) out.push(name)
  }
  return out
}

/**
 * Rewrites our stored named placeholders (`{{name}}`) into Meta's positional
 * form (`{{1}}`), numbered by first appearance. A repeated name reuses its
 * index, which keeps the declared variable count equal to the number of
 * parameters `buildTemplateComponents` supplies at send time.
 *
 * Lives here, beside the regex it depends on, so both the CREATE-shape builder
 * and the buttons translator can use it without importing each other.
 */
export function toPositionalText(text: string): { text: string; names: string[] } {
  const names = extractPlaceholders(text)
  const positional = text.replace(PLACEHOLDER, (_match, name: string) => `{{${names.indexOf(name) + 1}}}`)
  return { text: positional, names }
}

/**
 * A digit-only placeholder name means an operator typed a literal `{{1}}` into
 * stored text. The regex above accepts it as a name, so it would silently
 * become a real variable requiring a send-time value keyed "1" — which no
 * caller supplies, yielding a blank parameter on a live message. Callers refuse
 * it at registration rather than narrowing the regex, which would change
 * send-time semantics for already-stored templates.
 */
export function assertNoLiteralPositionals(names: string[], where: string): void {
  const literals = names.filter((name) => /^\d+$/.test(name))
  if (literals.length > 0) {
    throw new Error(
      `WABA ${where} contains literal positional placeholder(s) ${literals.map((n) => `{{${n}}}`).join(", ")} — use a named placeholder such as {{reference}}`,
    )
  }
}

/**
 * Rejects brace sequences that look like a placeholder but are not one.
 * `{{{name}}}` matches the inner `{{name}}` and leaves the outer braces as
 * literal text, so the borrower reads `{Thabo}`; `{{name}` matches nothing and
 * is sent verbatim. Both are authoring slips, caught at registration rather
 * than by narrowing the regex (which would change send-time semantics).
 */
export function placeholderBraceProblem(text: string): string | null {
  if (text.includes("{{{") || text.includes("}}}")) {
    return "has malformed placeholder braces — use exactly {{name}}"
  }
  // Only an ATTEMPTED placeholder counts. After removing valid ones, `{{` glued
  // to a name (`{{ref`) is an unclosed attempt, and a name glued to `}}`
  // (`ref}}`) is a stray close. A loose `}}` in prose ("use }} to close") has
  // whitespace around it and is literal text the author meant — rejecting that
  // would block a perfectly valid template from ever registering.
  const stripped = text.replace(PLACEHOLDER, "")
  if (/\{\{[a-zA-Z0-9_]/.test(stripped)) {
    return "has an unclosed placeholder — use exactly {{name}}"
  }
  if (/[a-zA-Z0-9_]\}\}/.test(stripped)) {
    return "has a stray closing placeholder brace — use exactly {{name}}"
  }
  return null
}

export function assertWellFormedPlaceholders(text: string, where: string): void {
  const problem = placeholderBraceProblem(text)
  if (problem) throw new Error(`WABA ${where} ${problem}`)
}

function componentFor(
  type: "body" | "header",
  text: string | null,
  vars: Record<string, string>,
): WaTemplateComponent | null {
  if (!text) return null
  const names = extractPlaceholders(text)
  if (names.length === 0) return null
  return { type, parameters: names.map((n) => ({ type: "text", text: vars[n] ?? "" })) }
}

/** Meta allows at most two URL buttons per template. Exported so the CREATE
 * path shares this cap rather than keeping its own copy — two copies can
 * silently diverge, which is the failure this module exists to prevent. */
export const MAX_URL_BUTTONS = 2

/**
 * Why a button url's variable is unusable, or null if the url is fine (either
 * static, or exactly one variable appended to the end).
 *
 * ONE definition of the rule, shared by the CREATE path (which turns a problem
 * into a specific error) and the SEND path (which treats it as unsendable).
 * Two copies could disagree, and a disagreement means Meta approves one shape
 * and receives another — it substitutes the approval-time example url, so
 * every borrower gets the same link.
 */
export function urlVariableProblem(url: string): string | null {
  // Same brace rule as body/header — one definition, so the url path cannot
  // end up with weaker protection than the text paths.
  const braces = placeholderBraceProblem(url)
  if (braces) return braces
  const names = extractPlaceholders(url)
  if (names.length === 0) return null
  if (names.some((name) => /^\d+$/.test(name))) return "contains a literal positional placeholder"
  if (names.length > 1) return `supports one variable, found ${names.length}`
  const positional = toPositionalText(url).text
  // Count OCCURRENCES, not distinct names: extractPlaceholders dedupes.
  if (positional.indexOf("{{1}}") !== positional.lastIndexOf("{{1}}")) {
    return "variable may appear only once"
  }
  if (!positional.endsWith("{{1}}")) return "variable must be at the end of the url"
  return null
}

export type SendButtons =
  | { ok: true; variables: Array<{ index: number; name: string }> }
  | { ok: false; reason: string }

/**
 * The SEND-path view of the stored buttons column. Never throws — a malformed
 * row must not crash a live send — and anything it reports as `ok: false` is
 * treated by callers like a missing variable: the template is not used at all,
 * rather than sent as a partial payload.
 *
 * Scope: this mirrors every CREATE rule that determines a button's INDEX or
 * VALUE — url-variable shape (via the shared `urlVariableProblem`), array and
 * per-entry shape, and the URL-button cap. It deliberately does NOT replicate
 * CREATE's other registration limits (max 10 buttons, max 1 phone button,
 * contiguous quick-replies): those cannot change which value lands in which
 * button, and a blob violating them could never have been approved anyway.
 */
export function readSendButtons(buttons: unknown): SendButtons {
  if (buttons === null || buttons === undefined) return { ok: true, variables: [] }
  if (!Array.isArray(buttons)) return { ok: false, reason: "buttons is not an array" }
  const variables: Array<{ index: number; name: string }> = []
  let urlButtons = 0
  const entries = Array.from(buttons as unknown[])
  for (const [index, entry] of entries.entries()) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return { ok: false, reason: `button ${index} is not an object` }
    }
    const button = entry as Record<string, unknown>
    if (button.type !== "URL") continue
    if (typeof button.url !== "string") return { ok: false, reason: `button ${index} has no url` }
    urlButtons += 1
    if (urlButtons > MAX_URL_BUTTONS) {
      return { ok: false, reason: `more than ${MAX_URL_BUTTONS} URL buttons` }
    }
    const problem = urlVariableProblem(button.url)
    if (problem) return { ok: false, reason: `button ${index} ${problem}` }
    const names = extractPlaceholders(button.url)
    if (names.length === 1) variables.push({ index, name: names[0] })
  }
  return { ok: true, variables }
}

/** Variable names a template's URL buttons need at send time. Lets send.ts's
 * missing-variable gate see button placeholders, not just body/header ones. */
export function extractButtonPlaceholders(buttons: unknown): string[] {
  const read = readSendButtons(buttons)
  return read.ok ? read.variables.map((b) => b.name) : []
}

/**
 * Builds the Graph `components` array from a stored MessageTemplate + rendered
 * vars. Header first (Meta's required order), then body, then one `button`
 * component per URL button carrying a variable. Positional text parameters
 * follow first-seen placeholder order.
 */
export function buildTemplateComponents(
  input: { bodyTemplate: string | null; headerContent: string | null; buttons?: unknown },
  vars: Record<string, string>,
): WaTemplateComponent[] {
  const out: WaTemplateComponent[] = []
  const header = componentFor("header", input.headerContent, vars)
  if (header) out.push(header)
  const body = componentFor("body", input.bodyTemplate, vars)
  if (body) out.push(body)
  // A shape CREATE would refuse contributes no parameters at all: a partial
  // button payload is worse than none, because Meta then renders the
  // approval-time example url to a real recipient.
  const buttons = readSendButtons(input.buttons)
  for (const { index, name } of buttons.ok ? buttons.variables : []) {
    out.push({
      type: "button",
      sub_type: "url",
      index: String(index),
      // Meta appends this to the registered url, so it must be percent-encoded
      // (their own example: Gonçalves → Gon%C3%A7alves). Callers must therefore
      // pass a RAW value — pre-encoding it here would double-encode, and a "%"
      // cannot be told apart from an escape after the fact.
      // Trimmed to match send.ts's blank check, which also trims; otherwise
      // "  LN123  " passes that check and bakes its padding into the link.
      parameters: [{ type: "text", text: encodeURIComponent((vars[name] ?? "").trim()) }],
    })
  }
  return out
}
