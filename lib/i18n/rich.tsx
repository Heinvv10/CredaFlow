import { Fragment, type ReactNode } from "react"

const TAG = /<(\w+)>([\s\S]*?)<\/\1>/g

/**
 * Renders a translated message that marks emphasis or links with simple tags,
 * e.g. "Pay <b>{amount}</b> by {date}". Word order differs between languages,
 * so the markup travels inside the message rather than being split around it.
 * Only the tags given here render; anything else stays as literal text, and
 * every chunk is a React text node (never HTML).
 */
export function richText(message: string, tags: Record<string, (chunk: string) => ReactNode>): ReactNode {
  const out: ReactNode[] = []
  let last = 0
  for (const match of message.matchAll(TAG)) {
    const [whole, name, chunk] = match
    const render = tags[name]
    if (!render) continue
    const start = match.index ?? 0
    if (start > last) out.push(message.slice(last, start))
    out.push(<Fragment key={start}>{render(chunk)}</Fragment>)
    last = start + whole.length
  }
  if (last < message.length) out.push(message.slice(last))
  return <>{out}</>
}
