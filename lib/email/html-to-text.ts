// Minimal HTML → plain-text conversion for the text/plain half of a
// multipart/alternative email. NOT a general-purpose renderer — it's tuned for
// our transactional templates (label/value tables, paragraphs, a CTA link, a
// footer). Its job is a readable fallback and the mere PRESENCE of a text part
// (which avoids the HTML-only spam signal), not pixel-perfect layout.

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”",
  middot: "·", mdash: "—", ndash: "–", hellip: "…",
  copy: "©", reg: "®", trade: "™", deg: "°",
}

function safeFromCodePoint(cp: number): string {
  return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : ""
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => safeFromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeFromCodePoint(parseInt(d, 10)))
    .replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, (m, name) => NAMED_ENTITIES[name] ?? m)
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "")
}

export function htmlToPlainText(html: string): string {
  if (!html) return ""
  let s = html
  // Drop non-content blocks (incl. their contents) entirely.
  s = s.replace(/<(style|script|head)\b[\s\S]*?<\/\1>/gi, "")
  // Preserve link targets as "text (url)" so the CTA is usable in plain text.
  s = s.replace(/<a\b[^>]*\bhref=["']?([^"'\s>]+)["']?[^>]*>([\s\S]*?)<\/a>/gi, (_m, url, inner) => {
    const text = stripTags(String(inner)).trim()
    // mailto: links read as just the address (or "label <addr>"), never the
    // redundant "addr (mailto:addr)".
    if (/^mailto:/i.test(url)) {
      const addr = url.slice(url.indexOf(":") + 1)
      return !text || text === addr ? addr : `${text} (${addr})`
    }
    if (!text) return url
    return text === url ? url : `${text} (${url})`
  })
  // Block boundaries → line breaks.
  s = s.replace(/<br\s*\/?>/gi, "\n")
  // Table cells → a space between them, so a row written on ONE source line
  // (`<td>label</td><td>value</td>`) doesn't fuse into "labelvalue". A space
  // (not a newline) keeps multi-line-source rows unchanged — the trailing space
  // is trimmed at the line end.
  s = s.replace(/<\/(td|th)\s*>/gi, " ")
  s = s.replace(/<\/(p|div|tr|table|li|h[1-6]|blockquote|section|header|footer)\s*>/gi, "\n")
  // Everything else: drop tags, decode entities.
  s = decodeEntities(stripTags(s))
  // Whitespace: collapse intra-line runs, trim each line, cap consecutive blanks.
  return s
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/[ \t ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}
