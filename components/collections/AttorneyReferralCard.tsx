"use client"

import { useEffect, useState } from "react"
import { Briefcase, Phone, Mail, User, Hash, FileText, ExternalLink } from "lucide-react"
import { SAST_TIME_ZONE } from "@/lib/utils"

interface Referral {
  firmName: string
  contactPerson?: string | null
  contactPhone?: string | null
  contactEmail?: string | null
  matterNumber?: string | null
  referralDate: string
  notes?: string | null
}

interface Props {
  loanId: string
}

function formatDate(d: string) {
  return new Date(d).toLocaleDateString("en-ZA", { day: "2-digit", month: "long", year: "numeric", timeZone: SAST_TIME_ZONE })
}

export function AttorneyReferralCard({ loanId }: Props) {
  const [referral, setReferral] = useState<Referral | null | undefined>(undefined)

  useEffect(() => {
    fetch(`/api/loans/${loanId}/attorney-referral`)
      .then(r => r.json())
      .then(d => setReferral(d ?? null))
      .catch(() => setReferral(null))
  }, [loanId])

  if (referral === undefined) {
    return (
      <div className="bg-white rounded-lg border border-gray-100 shadow-sm p-5">
        <div className="h-4 bg-gray-100 rounded animate-pulse w-1/3 mb-3" />
        <div className="h-16 bg-gray-50 rounded animate-pulse" />
      </div>
    )
  }

  if (!referral) return null

  return (
    <div className="bg-white rounded-lg border border-purple-100 shadow-sm overflow-hidden">
      {/* Header */}
      <div className="px-5 py-4 border-b border-purple-50 flex items-center gap-3" style={{ background: "linear-gradient(135deg, #faf5ff 0%, #fff 100%)" }}>
        <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: "#EDE9FE" }}>
          <Briefcase className="h-4 w-4" style={{ color: "#7C3AED" }} />
        </div>
        <div className="flex-1">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-purple-300">Attorney Referral</p>
          <p className="font-bold text-sm text-purple-900 mt-0.5">{referral.firmName}</p>
        </div>
        <div className="text-right">
          <p className="text-[10px] text-purple-300">Referred</p>
          <p className="text-[12px] font-semibold text-purple-600">{formatDate(referral.referralDate)}</p>
        </div>
      </div>

      {/* Details grid */}
      <div className="px-5 py-4 grid grid-cols-2 gap-3">
        {referral.contactPerson && (
          <div className="flex items-start gap-2">
            <User className="h-3.5 w-3.5 text-purple-300 mt-0.5 flex-shrink-0" />
            <div>
              <p className="text-[10px] text-gray-400 font-semibold uppercase">Contact</p>
              <p className="text-[12px] font-medium text-gray-700">{referral.contactPerson}</p>
            </div>
          </div>
        )}
        {referral.contactPhone && (
          <div className="flex items-start gap-2">
            <Phone className="h-3.5 w-3.5 text-purple-300 mt-0.5 flex-shrink-0" />
            <div>
              <p className="text-[10px] text-gray-400 font-semibold uppercase">Phone</p>
              <a href={`tel:${referral.contactPhone}`} className="text-[12px] font-medium text-purple-600 hover:underline">
                {referral.contactPhone}
              </a>
            </div>
          </div>
        )}
        {referral.contactEmail && (
          <div className="flex items-start gap-2">
            <Mail className="h-3.5 w-3.5 text-purple-300 mt-0.5 flex-shrink-0" />
            <div>
              <p className="text-[10px] text-gray-400 font-semibold uppercase">Email</p>
              <a href={`mailto:${referral.contactEmail}`} className="text-[12px] font-medium text-purple-600 hover:underline flex items-center gap-1">
                {referral.contactEmail}
                <ExternalLink className="h-2.5 w-2.5" />
              </a>
            </div>
          </div>
        )}
        {referral.matterNumber && (
          <div className="flex items-start gap-2">
            <Hash className="h-3.5 w-3.5 text-purple-300 mt-0.5 flex-shrink-0" />
            <div>
              <p className="text-[10px] text-gray-400 font-semibold uppercase">Matter No.</p>
              <p className="text-[12px] font-mono font-semibold text-gray-700">{referral.matterNumber}</p>
            </div>
          </div>
        )}
      </div>

      {referral.notes && (
        <div className="px-5 pb-4">
          <div className="flex items-start gap-2 bg-purple-50 rounded-md px-3 py-2">
            <FileText className="h-3.5 w-3.5 text-purple-300 mt-0.5 flex-shrink-0" />
            <p className="text-[12px] text-purple-700">{referral.notes}</p>
          </div>
        </div>
      )}
    </div>
  )
}
