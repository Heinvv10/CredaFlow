"use client"

import { useId, useState } from "react"
import { ChevronDown } from "lucide-react"

export interface FaqItem {
  question: string
  answer: string
}

export interface FaqGroup {
  heading: string
  items: readonly FaqItem[]
}

interface FaqAccordionProps {
  /** Flat list of questions. Use this OR `groups`, not both. */
  items?: readonly FaqItem[]
  /** Grouped questions, each rendered under an <h2> section heading. */
  groups?: readonly FaqGroup[]
}

// Defined at module scope (not inside FaqAccordion's render) so React keeps the
// same component identity across state changes — otherwise every row would
// remount on each open/close, killing the collapse animation and button focus.
function FaqRow({
  faq,
  baseId,
  rowKey,
  isOpen,
  onToggle,
}: {
  faq: FaqItem
  baseId: string
  rowKey: string
  isOpen: boolean
  onToggle: () => void
}) {
  const panelId = `${baseId}-panel-${rowKey}`
  const btnId = `${baseId}-btn-${rowKey}`
  return (
    <div className="border border-white/12 bg-white/[0.035]">
      <button
        id={btnId}
        type="button"
        aria-expanded={isOpen}
        aria-controls={panelId}
        onClick={onToggle}
        className="flex w-full items-center justify-between gap-4 p-5 text-left"
      >
        <span className="font-semibold text-white">{faq.question}</span>
        <ChevronDown
          className={`shrink-0 text-[#a5b4fc] transition-transform duration-200 ${isOpen ? "rotate-180" : ""}`}
          size={18}
          aria-hidden="true"
        />
      </button>
      <div
        id={panelId}
        role="region"
        aria-labelledby={btnId}
        className={`grid transition-[grid-template-rows] duration-200 ease-out ${isOpen ? "grid-rows-[1fr]" : "grid-rows-[0fr]"}`}
      >
        <div className="overflow-hidden">
          <p className="border-t border-white/10 px-5 pb-5 pt-4 text-sm leading-relaxed text-white/60">
            {faq.answer}
          </p>
        </div>
      </div>
    </div>
  )
}

/**
 * Shared accordion FAQ used across every marketing page so the FAQ sections
 * look and behave identically.
 *
 * - Single-open: opening one question closes any other (one at a time),
 *   page-wide — including across `groups`.
 * - Collapsed by default (saves vertical space).
 * - Answers stay in the rendered HTML (collapsed via CSS grid-rows, not
 *   conditional render) so FAQPage JSON-LD keeps matching visible content.
 * - Accessible: each row is a <button aria-expanded aria-controls> with a
 *   labelled region.
 *
 * Pass `items` for a flat list, or `groups` for section-headed lists; either
 * way a single open-state is shared so only one row is open page-wide.
 */
export function FaqAccordion({ items, groups }: FaqAccordionProps) {
  const baseId = useId()
  const [openKey, setOpenKey] = useState<string | null>(null)
  const toggle = (key: string) => setOpenKey((prev) => (prev === key ? null : key))

  if (groups) {
    return (
      <div className="space-y-10">
        {groups.map((group) => (
          <div key={group.heading}>
            <h2 className="mb-4 border-b border-white/10 pb-2 text-sm font-bold uppercase tracking-[0.24em] text-[#a5b4fc]">
              {group.heading}
            </h2>
            <div className="space-y-3">
              {group.items.map((faq) => {
                const rowKey = `${group.heading}::${faq.question}`
                return (
                  <FaqRow
                    key={rowKey}
                    faq={faq}
                    baseId={baseId}
                    rowKey={rowKey}
                    isOpen={openKey === rowKey}
                    onToggle={() => toggle(rowKey)}
                  />
                )
              })}
            </div>
          </div>
        ))}
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {(items ?? []).map((faq) => (
        <FaqRow
          key={faq.question}
          faq={faq}
          baseId={baseId}
          rowKey={faq.question}
          isOpen={openKey === faq.question}
          onToggle={() => toggle(faq.question)}
        />
      ))}
    </div>
  )
}
