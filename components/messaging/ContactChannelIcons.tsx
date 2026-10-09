"use client"

import { useState } from "react"
import { Mail, MessageCircle } from "lucide-react"
import { MessageClientDrawer } from "./MessageClientDrawer"
import type { Channel } from "./ChannelPicker"

type CannedReply = { id: string; title: string; body: string }

export type ContactChannelIconsProps = {
  clientId: string
  clientName: string
  cannedReplies: CannedReply[]
  hasEmail: boolean
  hasPhone: boolean
  loanId?: string
}

export function ContactChannelIcons(props: ContactChannelIconsProps) {
  const { clientId, clientName, cannedReplies, hasEmail, hasPhone, loanId } = props

  const [drawerOpen, setDrawerOpen] = useState(false)
  const [initialChannel, setInitialChannel] = useState<Channel | undefined>(undefined)

  function open(channel: Channel) {
    setInitialChannel(channel)
    setDrawerOpen(true)
  }

  if (!hasEmail && !hasPhone) return null

  // Root must be phrasing content (not a <div>): the applications/[id] case
  // file nests this inside a <p> (page.tsx:308-317). A <div> there is
  // invalid HTML — the browser's parser implicitly closes the <p> right
  // before it, producing a DOM shape that no longer matches what React
  // expects to hydrate onto, which is exactly React error #418 (confirmed
  // by curling the raw SSR output: the byte stream showed
  // `<p ...><span>...</span><div class="inline-flex ...">` verbatim). A
  // <span> with the same flex utilities renders identically and is valid
  // inside <p>.
  return (
    <span className="inline-flex items-center gap-1.5">
      {hasEmail && (
        <button
          type="button"
          onClick={() => open("EMAIL")}
          aria-label={`Email ${clientName}`}
          title={`Email ${clientName}`}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-gray-400 hover:bg-amber-50 hover:text-[#4F46E5]"
        >
          <Mail size={16} />
        </button>
      )}
      {hasPhone && (
        <button
          type="button"
          onClick={() => open("WHATSAPP")}
          aria-label={`WhatsApp ${clientName}`}
          title={`WhatsApp ${clientName}`}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-gray-400 hover:bg-amber-50 hover:text-[#4F46E5]"
        >
          <MessageCircle size={16} />
        </button>
      )}

      <MessageClientDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        clientId={clientId}
        clientName={clientName}
        cannedReplies={cannedReplies}
        initialChannel={initialChannel}
        loanId={loanId}
      />
    </span>
  )
}
