import { Fragment } from "react"
import { chatBlocks, type ChatInline } from "@/lib/website-chat/chat-format"

const linkClass = "underline underline-offset-2 hover:text-[var(--cf-brand-alt)]"

function Inline({ parts }: { parts: ChatInline[] }) {
  return parts.map((p, i) => {
    // Our own pages, in this tab: the chat carries on across the navigation (useWebsiteChat).
    const body = p.href ? <a href={p.href} className={linkClass}>{p.text}</a> : p.text
    return p.bold ? <strong key={i} className="font-semibold">{body}</strong> : <Fragment key={i}>{body}</Fragment>
  })
}

/** An assistant or staff line, formatted (lib/website-chat/chat-format.ts) as React elements, never HTML. */
export function ChatText({ text }: { text: string }) {
  return (
    <div className="space-y-2">
      {chatBlocks(text).map((block, i) => {
        if (block.kind === "p") {
          return (
            <p key={i}>
              {block.lines.map((line, j) => (
                <Fragment key={j}>{j > 0 && <br />}<Inline parts={line} /></Fragment>
              ))}
            </p>
          )
        }
        const items = block.items.map((item, j) => <li key={j}><Inline parts={item} /></li>)
        return block.kind === "ul"
          ? <ul key={i} className="list-disc space-y-0.5 pl-5">{items}</ul>
          : <ol key={i} start={block.start} className="list-decimal space-y-0.5 pl-5">{items}</ol>
      })}
    </div>
  )
}
