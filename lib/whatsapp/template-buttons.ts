import { extractPlaceholders, toPositionalText, urlVariableProblem, MAX_URL_BUTTONS } from "./template-components"

/**
 * The stored shape of MessageTemplate.buttons (a Json? column). This is the
 * contract the WABA template editor writes and this module translates — Meta's
 * own taxonomy, with phoneNumber camelCased to match the rest of our schema.
 */
export type StoredTemplateButton =
  | { type: "QUICK_REPLY"; text: string }
  | { type: "URL"; text: string; url: string }
  | { type: "PHONE_NUMBER"; text: string; phoneNumber: string }

/** A button in Meta's template-CREATE shape. `example` is present only on a
 * URL button whose url ends in a variable — Meta requires it exactly then, and
 * `buildTemplateComponents` supplies the matching send-time parameter. */
export type WaCreateButton =
  | { type: "QUICK_REPLY"; text: string }
  | { type: "URL"; text: string; url: string; example?: string[] }
  | { type: "PHONE_NUMBER"; text: string; phone_number: string }

export type WaButtonsComponent = { type: "BUTTONS"; buttons: WaCreateButton[] }

// Meta's documented caps (Business Management API → templates → components).
const MAX_BUTTONS = 10
const MAX_PHONE_BUTTONS = 1
const MAX_TEXT = 25
const MAX_URL = 2000
const MAX_PHONE = 20

/** Meta caps label text at "25 characters". Counted as user-perceived
 * characters (grapheme clusters) rather than UTF-16 code units, so an emoji or
 * a combining-mark accent counts once. Meta remains the final authority; this
 * is the reading least likely to reject a label a person would call valid. */
function characterCount(text: string): number {
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })
  return Array.from(segmenter.segment(text)).length
}

function readText(raw: Record<string, unknown>, index: number): string {
  const text = typeof raw.text === "string" ? raw.text.trim() : ""
  if (!text) throw new Error(`Button ${index}: text is required`)
  const length = characterCount(text)
  if (length > MAX_TEXT) {
    throw new Error(`Button ${index}: text is ${length} characters, Meta allows ${MAX_TEXT}`)
  }
  return text
}

function buildUrlButton(raw: Record<string, unknown>, index: number, text: string): WaCreateButton {
  const url = typeof raw.url === "string" ? raw.url.trim() : ""
  if (!url) throw new Error(`Button ${index}: url is required for a URL button`)
  if (url.length > MAX_URL) {
    throw new Error(`Button ${index}: url is ${url.length} characters, Meta allows ${MAX_URL}`)
  }
  // Client-facing links from a credit provider must not be plaintext.
  if (!url.startsWith("https://")) {
    throw new Error(`Button ${index}: url must start with https://`)
  }
  // urlVariableProblem is the SINGLE definition of this rule, shared with the
  // send path (template-components.ts). Two copies could disagree, and a
  // disagreement means Meta approves one shape and receives another.
  const problem = urlVariableProblem(url)
  if (problem) throw new Error(`Button ${index}: a URL button ${problem}`)
  const names = extractPlaceholders(url)
  if (names.length === 0) return { type: "URL", text, url }
  return { type: "URL", text, url: toPositionalText(url).text, example: names }
}

/**
 * Translates the stored buttons column into Meta's BUTTONS component, applying
 * the platform's own limits up front — a rejected CREATE surfaces as an opaque
 * Graph error, so failing here is cheaper and far more legible.
 *
 * Returns null when there are no buttons (absent, or an empty array), so the
 * caller simply omits the component.
 */
export function buildButtonsComponent(raw: unknown): WaButtonsComponent | null {
  if (raw === null || raw === undefined) return null
  if (!Array.isArray(raw)) throw new Error("buttons must be an array")
  if (raw.length === 0) return null
  if (raw.length > MAX_BUTTONS) {
    throw new Error(`${raw.length} buttons declared, Meta allows ${MAX_BUTTONS}`)
  }

  // Array.from fills holes in a sparse array with undefined; raw.map would skip
  // them, letting a hole past the guard below.
  const buttons: WaCreateButton[] = Array.from(raw as unknown[]).map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`Button ${index}: expected an object`)
    }
    const button = entry as Record<string, unknown>
    const text = readText(button, index)
    switch (button.type) {
      case "QUICK_REPLY":
        return { type: "QUICK_REPLY", text }
      case "URL":
        return buildUrlButton(button, index, text)
      case "PHONE_NUMBER": {
        const phoneNumber = typeof button.phoneNumber === "string" ? button.phoneNumber.trim() : ""
        if (!phoneNumber) throw new Error(`Button ${index}: phoneNumber is required for a PHONE_NUMBER button`)
        // Meta documents no format beyond "alphanumeric string", so only the
        // documented length cap is enforced — a format regex would guess.
        if (phoneNumber.length > MAX_PHONE) {
          throw new Error(`Button ${index}: phoneNumber is ${phoneNumber.length} characters, Meta allows ${MAX_PHONE}`)
        }
        return { type: "PHONE_NUMBER", text, phone_number: phoneNumber }
      }
      default:
        throw new Error(`Button ${index}: unsupported button type ${String(button.type)}`)
    }
  })

  const urlCount = buttons.filter((b) => b.type === "URL").length
  if (urlCount > MAX_URL_BUTTONS) {
    throw new Error(`${urlCount} URL buttons declared, Meta allows ${MAX_URL_BUTTONS}`)
  }
  const phoneCount = buttons.filter((b) => b.type === "PHONE_NUMBER").length
  if (phoneCount > MAX_PHONE_BUTTONS) {
    throw new Error(`${phoneCount} phone-number buttons declared, Meta allows ${MAX_PHONE_BUTTONS}`)
  }

  // Meta errors if quick replies are interspersed with other types rather than
  // grouped, so require them to form one contiguous run.
  const quickReplyPositions = buttons
    .map((b, i) => (b.type === "QUICK_REPLY" ? i : -1))
    .filter((i) => i >= 0)
  if (quickReplyPositions.length > 1) {
    const span = quickReplyPositions[quickReplyPositions.length - 1] - quickReplyPositions[0] + 1
    if (span !== quickReplyPositions.length) {
      throw new Error("quick-reply buttons must be contiguous, not interspersed with other types")
    }
  }

  return { type: "BUTTONS", buttons }
}
