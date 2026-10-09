/**
 * Splits an internal note into text and the same-origin paths the website chat
 * writes into its notes (lib/website-chat/store.ts), so the inbox and the lead
 * timeline can render those as links. Client-safe: pure text, no prisma.
 *
 * A note's text is partly visitor-supplied, so a path links only on a line that
 * starts with one of the labels the app itself writes and holds nothing but
 * paths after it. A path anywhere else, e.g. planted in a visitor's email, stays
 * text, and nothing that could carry another origin, a longer path or extra
 * query parameters ever becomes an href.
 */
const LINK_LABELS = ["CRM lead: ", "Inbox thread: ", "Earlier website chats from this number (not verified): "]
const APP_PATH = /^(?:\/crm\/leads\/|\/inbox\?conversationId=)[A-Za-z0-9_-]+$/

export type NotePart = { text: string; href?: string }

/** The label's paths, if the whole line is a label followed only by app paths. */
function linkLine(line: string): { label: string; paths: string[]; stop: string } | null {
  const label = LINK_LABELS.find((l) => line.startsWith(l))
  if (!label) return null
  const rest = line.slice(label.length)
  const stop = rest.endsWith(".") ? "." : ""
  const paths = rest.slice(0, rest.length - stop.length).split(", ")
  return paths.every((p) => APP_PATH.test(p)) ? { label, paths, stop } : null
}

export function splitNoteLinks(text: string): NotePart[] {
  const parts: NotePart[] = []
  const plain = (t: string) => {
    if (!t) return
    const last = parts[parts.length - 1]
    if (last && !last.href) last.text += t
    else parts.push({ text: t })
  }
  text.split("\n").forEach((line, i) => {
    if (i > 0) plain("\n")
    const found = linkLine(line)
    if (!found) return plain(line)
    plain(found.label)
    found.paths.forEach((path, j) => {
      if (j > 0) plain(", ")
      parts.push({ text: path, href: path })
    })
    plain(found.stop)
  })
  return parts
}
