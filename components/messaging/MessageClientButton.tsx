"use client"

import { useEffect, useRef, useState } from "react"
import { ChevronDown } from "lucide-react"
import { MessageClientDrawer } from "./MessageClientDrawer"
import { CHANNEL_ORDER, type Channel } from "./ChannelPicker"

type CannedReply = { id: string; title: string; body: string }
type QuickAction = {
  label: string
  channel: Channel
  prefill: { subject?: string; body?: string }
}

export type MessageClientButtonProps = {
  clientId: string
  clientName: string
  cannedReplies: CannedReply[]
  loanId?: string
  quickActions?: QuickAction[]
  // Full-width outline variant for stacked action rails (e.g. the review
  // Decision rail, where siblings are full-width outline buttons). Default is
  // the compact bronze inline button used in page headers.
  fullWidth?: boolean
  // API prefix forwarded to the drawer (defaults to the client message
  // routes). The lead page passes /api/crm/leads/:id.
  apiBase?: string
}

const CHANNEL_LABELS: Record<Channel, string> = { EMAIL: "Email", WHATSAPP: "WhatsApp", SMS: "SMS" }

export function MessageClientButton(props: MessageClientButtonProps) {
  const { clientId, clientName, cannedReplies, loanId, quickActions = [], fullWidth = false, apiBase } = props

  const [menuOpen, setMenuOpen] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [initialChannel, setInitialChannel] = useState<Channel | undefined>(undefined)
  const [prefill, setPrefill] = useState<{ subject?: string; body?: string } | undefined>(undefined)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menuOpen) return
    function onClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false)
    }
    document.addEventListener("mousedown", onClickOutside)
    return () => document.removeEventListener("mousedown", onClickOutside)
  }, [menuOpen])

  function openChannel(channel: Channel) {
    setInitialChannel(channel)
    setPrefill(undefined)
    setMenuOpen(false)
    setDrawerOpen(true)
  }

  function openQuickAction(action: QuickAction) {
    setInitialChannel(action.channel)
    setPrefill(action.prefill)
    setMenuOpen(false)
    setDrawerOpen(true)
  }

  return (
    <div className={fullWidth ? "relative w-full" : "relative inline-block"} ref={menuRef}>
      <button
        type="button"
        onClick={() => setMenuOpen((v) => !v)}
        className={
          fullWidth
            ? "flex w-full items-center justify-center gap-1.5 px-4 py-2 border border-[#4F46E5] text-[#4F46E5] bg-white text-sm font-semibold rounded-lg hover:bg-amber-50"
            : "inline-flex items-center gap-1.5 px-4 py-2 bg-[#4F46E5] text-white text-sm font-semibold rounded-lg hover:bg-[#4338CA]"
        }
      >
        Message
        <ChevronDown size={16} />
      </button>

      {menuOpen && (
        <div className={`absolute z-40 mt-1 rounded-lg border border-gray-200 bg-white py-1 shadow-lg ${fullWidth ? "left-0 w-full" : "right-0 w-56"}`}>
          {CHANNEL_ORDER.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => openChannel(c)}
              className="block w-full px-3 py-2 text-left text-sm text-[#1b1d24] hover:bg-amber-50"
            >
              {CHANNEL_LABELS[c]}
            </button>
          ))}
          {quickActions.length > 0 && (
            <>
              <div className="my-1 border-t border-gray-100" />
              {quickActions.map((action) => (
                <button
                  key={action.label}
                  type="button"
                  onClick={() => openQuickAction(action)}
                  className="block w-full px-3 py-2 text-left text-sm text-[#1b1d24] hover:bg-amber-50"
                >
                  {action.label}
                </button>
              ))}
            </>
          )}
        </div>
      )}

      <MessageClientDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        clientId={clientId}
        clientName={clientName}
        cannedReplies={cannedReplies}
        initialChannel={initialChannel}
        prefill={prefill}
        loanId={loanId}
        apiBase={apiBase}
      />
    </div>
  )
}
