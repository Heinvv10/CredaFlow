"use client"

import { Plus, Trash2 } from "lucide-react"
import type { StoredTemplateButton } from "@/lib/whatsapp/template-buttons"

/**
 * Editor for MessageTemplate.buttons. Writes the StoredTemplateButton contract
 * exactly — switching a row's type replaces the whole object rather than
 * patching it, so a URL row can never leave a stale `phoneNumber` behind.
 *
 * Deliberately holds NO validation of its own: every limit (labels, counts,
 * url shape) is enforced by buildButtonsComponent through the live preview,
 * which is the same function the server and Meta's payload go through.
 */

type Props = {
  buttons: StoredTemplateButton[]
  onChange: (buttons: StoredTemplateButton[]) => void
  disabled?: boolean
}

const BLANK: Record<StoredTemplateButton["type"], StoredTemplateButton> = {
  QUICK_REPLY: { type: "QUICK_REPLY", text: "" },
  URL: { type: "URL", text: "", url: "https://" },
  PHONE_NUMBER: { type: "PHONE_NUMBER", text: "", phoneNumber: "" },
}

const TYPE_LABEL: Record<StoredTemplateButton["type"], string> = {
  QUICK_REPLY: "Quick reply",
  URL: "Link",
  PHONE_NUMBER: "Call",
}

const inputClass =
  "w-full border border-gray-300 rounded px-2.5 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-[#4F46E5] disabled:bg-gray-50"

export function WabaButtonsBuilder({ buttons, onChange, disabled }: Props) {
  const replace = (index: number, next: StoredTemplateButton) => {
    onChange(buttons.map((b, i) => (i === index ? next : b)))
  }

  return (
    <div className="space-y-2">
      {buttons.length === 0 && (
        <p className="text-xs text-gray-400">No buttons. Meta allows up to 10.</p>
      )}

      {buttons.map((button, index) => (
        <div key={index} className="flex flex-wrap items-start gap-2 bg-[#f9fafb] border border-[#e5e7eb] rounded p-2">
          <select
            aria-label={`Button ${index + 1} type`}
            value={button.type}
            disabled={disabled}
            // Cloned, not shared: BLANK is module-level, and handing out the
            // same object reference would let two rows alias each other.
            onChange={(e) => replace(index, { ...BLANK[e.target.value as StoredTemplateButton["type"]] })}
            className={`${inputClass} w-32`}
          >
            {(Object.keys(BLANK) as Array<StoredTemplateButton["type"]>).map((type) => (
              <option key={type} value={type}>{TYPE_LABEL[type]}</option>
            ))}
          </select>

          <input
            aria-label={`Button ${index + 1} label`}
            type="text"
            placeholder="Label (max 25)"
            value={button.text}
            disabled={disabled}
            onChange={(e) => replace(index, { ...button, text: e.target.value })}
            className={`${inputClass} w-40`}
          />

          {button.type === "URL" && (
            <input
              aria-label={`Button ${index + 1} url`}
              type="text"
              placeholder="https://… (one {{variable}} at the end)"
              value={button.url}
              disabled={disabled}
              onChange={(e) => replace(index, { ...button, url: e.target.value })}
              className={`${inputClass} flex-1 min-w-[16rem] font-mono text-xs`}
            />
          )}

          {button.type === "PHONE_NUMBER" && (
            <input
              aria-label={`Button ${index + 1} phone number`}
              type="text"
              placeholder="27110000000"
              value={button.phoneNumber}
              disabled={disabled}
              onChange={(e) => replace(index, { ...button, phoneNumber: e.target.value })}
              className={`${inputClass} w-44 font-mono text-xs`}
            />
          )}

          <button
            type="button"
            aria-label={`Remove button ${index + 1}`}
            disabled={disabled}
            onClick={() => onChange(buttons.filter((_, i) => i !== index))}
            className="p-1.5 text-gray-400 hover:text-red-600 disabled:opacity-40"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      ))}

      <button
        type="button"
        disabled={disabled}
        onClick={() => onChange([...buttons, { ...BLANK.QUICK_REPLY }])}
        className="inline-flex items-center gap-1.5 text-xs font-medium text-[#4F46E5] hover:text-[#3730a3] disabled:opacity-40"
      >
        <Plus className="h-3.5 w-3.5" />Add button
      </button>
    </div>
  )
}
