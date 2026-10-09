"use client"

import { useState } from "react"
import { MessageCircle } from "lucide-react"
import { SendWhatsAppModal } from "@/components/crm/SendWhatsAppModal"

interface Props {
  clientId: string
  clientName: string
  phone: string
  daysInArrears: number
}

function autoDpdBucket(dpd: number): string {
  if (dpd >= 14) return "dpd_14"
  if (dpd >= 7) return "dpd_7"
  if (dpd >= 3) return "dpd_3"
  if (dpd >= 1) return "dpd_1"
  return "current"
}

export function CollectionsWaButton({ clientId, clientName, phone, daysInArrears }: Props) {
  const [open, setOpen] = useState(false)

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title={`WhatsApp ${clientName}`}
        className="p-1.5 rounded hover:bg-green-50 transition-colors group"
      >
        <MessageCircle className="h-4 w-4 text-gray-400 group-hover:text-green-600 transition-colors" />
      </button>
      <SendWhatsAppModal
        clientId={clientId}
        clientName={clientName}
        phone={phone}
        isOpen={open}
        onClose={() => setOpen(false)}
        defaultDpdBucket={autoDpdBucket(daysInArrears)}
      />
    </>
  )
}
