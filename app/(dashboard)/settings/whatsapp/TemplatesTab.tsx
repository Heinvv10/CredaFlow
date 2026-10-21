"use client"

import { useState } from "react"

export interface WabaTemplateStatus {
  id: string
  wabaTemplateName: string | null
  providerStatus: string | null
}

// Presentational only — refreshed by app/api/cron/poll-wa-templates.
function WabaStatusBadge({ providerStatus }: { providerStatus: string | null }) {
  const status = providerStatus ?? "PENDING"
  const styles: Record<string, string> = {
    APPROVED: "bg-green-100 text-green-700",
    PENDING: "bg-amber-100 text-amber-700",
    REJECTED: "bg-red-100 text-red-700",
  }
  return (
    <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${styles[status] ?? "bg-gray-100 text-gray-600"}`}>
      {status}
    </span>
  )
}

const TEMPLATES = [
  { key: "application_submitted", label: "Application Received", trigger: "Client submits a loan application" },
  { key: "loan_approved", label: "Application Approved", trigger: "Admin approves an application" },
  { key: "application_declined", label: "Application Declined", trigger: "Admin declines an application" },
  { key: "loan_disbursed", label: "Loan Disbursed", trigger: "Funds disbursed to client" },
  { key: "payment_due_today", label: "Payment Due Today", trigger: "On the day payment is due" },
  { key: "payment_overdue_1d", label: "Payment Overdue (1 Day)", trigger: "1 day after missed payment" },
  { key: "payment_overdue_7d", label: "Payment Overdue (7 Days)", trigger: "7 days after missed payment — escalation" },
  { key: "payment_received", label: "Payment Received", trigger: "Payment recorded by admin or portal" },
  { key: "section129", label: "Section 129 Notice", trigger: "Section 129 notice issued" },
]

const TEMPLATE_PREVIEWS: Record<string, string> = {
  application_submitted: `Hi {name} 👋\n\nYour loan application *{ref}* for *{amount}* has been received.\n\nWe'll review it within 24 hours and be in touch.`,
  loan_approved: `Good news {name}! 🎉\n\nYour loan application for *{amount}* has been *approved*.\n\nRef: {ref}\n\nWe'll be in touch shortly to finalise the agreement.`,
  application_declined: `Hi {name},\n\nUnfortunately your application *{ref}* was unsuccessful at this time.\n\nPlease contact us if you have any questions.`,
  loan_disbursed: `Hi {name} ✅\n\nYour loan of *{amount}* has been paid to your account.\n\nFirst payment due on *{dueDate}*.`,
  payment_due_today: `Hi {name},\n\nYour loan payment of *{amount}* is due *today*.\n\nPayment reference: *{ref}*\n\nContact us if you need assistance.`,
  payment_overdue_1d: `Hi {name},\n\n⚠️ Your payment of *{amount}* on loan *{ref}* was due yesterday.\n\nPlease pay urgently to avoid additional charges.`,
  payment_overdue_7d: `URGENT - {name}\n\nLoan *{ref}* is *7 days overdue*. Outstanding: *{amount}*.\n\nContact us immediately: {phone}`,
  payment_received: `Hi {name} ✅\n\nWe've received your payment of *{amount}*.\n\nOutstanding balance: *{balance}*.`,
  section129: `Important notice for {name} — loan *{ref}*.\n\nA Section 129 notice has been sent to your email. Please contact us urgently.`,
}

export function TemplatesTab({ wabaTemplates }: { wabaTemplates: WabaTemplateStatus[] }) {
  const [previewKey, setPreviewKey] = useState<string | null>(null)

  return (
    <div className="space-y-6">
      {/* WABA template approval status — refreshed by the poll-wa-templates cron */}
      {wabaTemplates.length > 0 && (
        <div className="bg-white rounded-lg border border-gray-100 shadow-sm">
          <div className="px-5 py-4 border-b border-gray-50">
            <h2 className="font-semibold text-gray-900 text-sm">WABA Template Approval</h2>
            <p className="text-xs text-gray-400 mt-0.5">Meta review status for submitted WhatsApp Business templates.</p>
          </div>
          <div className="divide-y divide-gray-50">
            {wabaTemplates.map((t) => (
              <div key={t.id} className="px-5 py-3 flex items-center justify-between">
                <p className="text-sm font-medium text-gray-900">{t.wabaTemplateName}</p>
                <WabaStatusBadge providerStatus={t.providerStatus} />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Template library */}
      <div className="bg-white rounded-lg border border-gray-100 shadow-sm">
        <div className="px-5 py-4 border-b border-gray-50">
          <h2 className="font-semibold text-gray-900 text-sm">Message Templates</h2>
          <p className="text-xs text-gray-400 mt-0.5">These templates fire automatically at each lifecycle event. Click to preview.</p>
        </div>
        <div className="divide-y divide-gray-50">
          {TEMPLATES.map((t) => (
            <div key={t.key}>
              <button
                onClick={() => setPreviewKey(previewKey === t.key ? null : t.key)}
                className="w-full px-5 py-3.5 flex items-center justify-between hover:bg-gray-50 transition-colors text-left"
              >
                <div>
                  <p className="text-sm font-medium text-gray-900">{t.label}</p>
                  <p className="text-[11px] text-gray-400 mt-0.5">{t.trigger}</p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-green-100 text-green-700">AUTO</span>
                  <span className="text-xs text-gray-400">{previewKey === t.key ? "▲" : "▼"}</span>
                </div>
              </button>
              {previewKey === t.key && (
                <div className="px-5 pb-4">
                  <div className="bg-[#DCF8C6] rounded-lg p-3 max-w-sm ml-auto">
                    <pre className="text-[12px] text-gray-800 whitespace-pre-wrap font-sans leading-relaxed">
                      {TEMPLATE_PREVIEWS[t.key] ?? "(no preview available)"}
                    </pre>
                    <p className="text-[10px] text-gray-500 text-right mt-1">Preview only — variables replaced at send time</p>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
