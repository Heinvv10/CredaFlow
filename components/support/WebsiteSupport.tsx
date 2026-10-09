"use client"

import { useEffect, useState } from "react"
import { WhatsAppLauncher } from "@/components/support/WhatsAppLauncher"
import { WebsiteChat } from "@/components/support/WebsiteChat"
import { storeChatOpen, storedChatOpen, storedChatToken } from "@/components/support/chat-session"
import { WEBSITE_INTENTS } from "@/lib/support/whatsapp-intents"

/** `whatsappE164` is the lender's `identity.publicWhatsappE164`, null when none is configured. */
export function WebsiteSupport({ whatsappE164 }: { whatsappE164: string | null }) {
  const [chatEnabled, setChatEnabled] = useState(false)
  const [chatOpen, setChatOpen] = useState(false)

  useEffect(() => {
    let live = true
    fetch("/api/website/chat/status")
      .then((r) => (r.ok ? r.json() : { enabled: false }))
      .then((d: { enabled?: boolean }) => {
        if (!live) return
        setChatEnabled(d.enabled === true)
        // A chat under way on the page before this one comes with the visitor, unless they closed the panel; no chat, no panel.
        if (d.enabled === true && storedChatToken() && storedChatOpen()) setChatOpen(true)
      })
      .catch((err: unknown) => { console.error("[website-chat] status check failed", err) })
    return () => { live = false }
  }, [])

  const setOpen = (open: boolean) => {
    storeChatOpen(open)
    setChatOpen(open)
  }

  return (
    <>
      {chatOpen && <WebsiteChat whatsappE164={whatsappE164} onClose={() => setOpen(false)} />}
      <WhatsAppLauncher
        whatsappE164={whatsappE164}
        intents={chatEnabled ? WEBSITE_INTENTS.filter((i) => i.id === "complaint") : WEBSITE_INTENTS}
        chatAction={chatEnabled ? { label: "Chat with our assistant", onSelect: () => setOpen(true) } : undefined}
      />
    </>
  )
}
