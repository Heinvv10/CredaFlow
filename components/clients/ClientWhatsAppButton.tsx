"use client"

import { useState } from "react"
import { MessageCircle } from "lucide-react"
import { SendWhatsAppModal } from "@/components/crm/SendWhatsAppModal"

interface Props {
  clientId: string
  clientName: string
  phone: string
}

export function ClientWhatsAppButton({ clientId, clientName, phone }: Props) {
  const [open, setOpen] = useState(false)

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-2 px-3 py-2 rounded-md border border-gray-200 text-sm font-medium text-gray-700 hover:bg-green-50 hover:border-green-300 hover:text-green-700 transition-colors"
      >
        <MessageCircle className="h-4 w-4" style={{ color: "#25D366" }} />
        WhatsApp
      </button>
      <SendWhatsAppModal
        clientId={clientId}
        clientName={clientName}
        phone={phone}
        isOpen={open}
        onClose={() => setOpen(false)}
      />
    </>
  )
}
