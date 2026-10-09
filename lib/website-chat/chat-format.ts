// Pure and client-safe: imported by the widget, so no imports that reach @/lib/prisma.
import { websiteBaseUrl } from "@/lib/config/deployment-urls"

/**
 * The little markdown the assistant and staff write, as data the widget renders with React
 * elements (components/support/ChatText.tsx): paragraphs, line breaks, bullet and numbered
 * lists, **bold**, and links to our own site (bare, or as [label](target): the label alone when
 * the target is not on the list). Everything else stays literal text, and nothing
 * here is ever HTML.
 */
export type ChatInline = { text: string; bold?: boolean; href?: string }
export type ChatBlock =
  | { kind: "p"; lines: ChatInline[][] }
  | { kind: "ul"; items: ChatInline[][] }
  | { kind: "ol"; start: number; items: ChatInline[][] }

const BULLET = /^\s*[-*•]\s+(.*)$/
const NUMBERED = /^\s*(\d{1,3})\.\s+(.*)$/
const BOLD = /\*\*(.+?)\*\*/g

/**
 * Our own site, and nothing that could carry anyone else's: a relative /site or /portal
 * path, an https URL on the deployment's website host or its www. twin (the bare domain or the same
 * two paths) or on portal. (any path: the whole host is the client portal), or an address @ that
 * domain. The host comes from NEXT_PUBLIC_WEBSITE_URL; unset, only relative paths link.
 * Paths are [A-Za-z0-9/_-] only. A link may not start glued to a word, a path, a scheme or an @
 * ("evil.example/site/x", "//site/x", "javascript:/site/x"), and may not stop where a URL would
 * go on (a query, a fragment, a port, userinfo, ".html", ".evil.example"): such text is not linked
 * at all, rather than linked in part. Trailing punctuation is never part of a link.
 */
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

function buildLink(siteUrl: string | null): RegExp {
  const alternatives = ["\\/(?:site|portal)(?:\\/[\\w/-]*)?"]
  const host = siteUrl ? new URL(siteUrl).hostname.toLowerCase().replace(/^www\./, "") : null
  if (host) {
    const h = escapeRe(host)
    alternatives.unshift(
      `https:\\/\\/(?:(?:www\\.)?${h}(?:\\/(?:(?:site|portal)(?:\\/[\\w/-]*)?)?)?|portal\\.${h}(?:\\/[\\w/-]*)?)`,
      `[\\w.%+-]+@${h}`,
    )
  }
  return new RegExp(`(^|[^\\w.%+/:@-])(${alternatives.join("|")})(?![\\w/@-]|[?#:=&%]\\S|\\.[A-Za-z0-9])`, "g")
}

let linkFor: { key: string | null; re: RegExp } | null = null
/** The allow-list for this deployment. Read per call: NEXT_PUBLIC_* is inlined by Next only as a literal `process.env.X`. */
function link(): RegExp {
  const key = websiteBaseUrl({ NEXT_PUBLIC_WEBSITE_URL: process.env.NEXT_PUBLIC_WEBSITE_URL })
  if (!linkFor || linkFor.key !== key) linkFor = { key, re: buildLink(key) }
  linkFor.re.lastIndex = 0
  return linkFor.re
}

/**
 * [label](target): one line, no nested brackets, no spaces in the target, and at most one level of
 * parentheses inside it (so "javascript:alert(1)" is still one target). The two target alternatives
 * start on different characters, and every run is bounded, so matching is linear.
 */
const MARKDOWN_LINK = /\[([^[\]\n]{1,200})\]\(((?:[^()\s]|\([^()\s]*\)){1,300})\)/g

/** The target as a link href when it is, whole, on the allowlist; null otherwise. */
function allowedHref(target: string): string | null {
  const found = [...target.matchAll(link())]
  const m = found.length === 1 ? found[0] : null
  if (!m || m[1] !== "" || m[2] !== target) return null
  return target.includes("@") ? `mailto:${target}` : target
}

/** Text and the links in it, in order. Mirrors lib/inbox/note-links.ts: parts, never markup. */
export function chatLinks(text: string): ChatInline[] {
  const parts: ChatInline[] = []
  let at = 0
  for (const m of text.matchAll(MARKDOWN_LINK)) {
    parts.push(...bareLinks(text.slice(at, m.index)))
    const href = allowedHref(m[2])
    parts.push(href ? { text: m[1], href } : { text: m[1] })
    at = m.index + m[0].length
  }
  parts.push(...bareLinks(text.slice(at)))
  return parts
}

/** A run of text with no markdown links in it: its own addresses and paths, linked. */
function bareLinks(text: string): ChatInline[] {
  const parts: ChatInline[] = []
  let at = 0
  for (const m of text.matchAll(link())) {
    const start = m.index + m[1].length
    const link = m[2]
    if (start > at) parts.push({ text: text.slice(at, start) })
    parts.push({ text: link, href: link.includes("@") ? `mailto:${link}` : link })
    at = start + link.length
  }
  if (at < text.length) parts.push({ text: text.slice(at) })
  return parts
}

/** One line's bold runs and links. An unpaired ** stays as typed. */
export function chatInline(text: string): ChatInline[] {
  const parts: ChatInline[] = []
  let at = 0
  for (const m of text.matchAll(BOLD)) {
    parts.push(...chatLinks(text.slice(at, m.index)))
    parts.push(...chatLinks(m[1]).map((p) => ({ ...p, bold: true })))
    at = m.index + m[0].length
  }
  parts.push(...chatLinks(text.slice(at)))
  return parts
}

/**
 * Paragraphs split on a blank line and keep their single line breaks. Consecutive items of one
 * kind make a list, which a blank line between items does not end; any other line ends it.
 */
export function chatBlocks(text: string): ChatBlock[] {
  const blocks: ChatBlock[] = []
  let open: ChatBlock | null = null
  let gap = false
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (line.trim() === "") {
      gap = true
      continue
    }
    const bullet = BULLET.exec(line)
    const numbered = bullet ? null : NUMBERED.exec(line)
    if (bullet) {
      const item = chatInline(bullet[1])
      if (open?.kind === "ul") open.items.push(item)
      else blocks.push((open = { kind: "ul", items: [item] }))
    } else if (numbered) {
      const item = chatInline(numbered[2])
      if (open?.kind === "ol") open.items.push(item)
      else blocks.push((open = { kind: "ol", start: Number(numbered[1]), items: [item] }))
    } else if (open?.kind === "p" && !gap) open.lines.push(chatInline(line))
    else blocks.push((open = { kind: "p", lines: [chatInline(line)] }))
    gap = false
  }
  return blocks
}
