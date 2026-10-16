import { BadgeCheck, ShieldCheck } from "lucide-react"
import type { LenderIdentity } from "@/lib/config/identity-schema"
import { demoLenderNote } from "@/lib/config/demo-mode"

// Above-the-fold licensing strip: the NCR and FSP numbers are the first thing
// crawlers see on `/`. They come from the tenant's own LenderIdentity; never inline.
// No FSP number, no FAIS claim. On a demo stack the numbers are a fictional
// demo lender's, and the strip says so.
export function RegulatoryBand({ identity }: { identity: Pick<LenderIdentity, "ncrNumber" | "fspNumber"> }) {
  const demoNote = demoLenderNote()
  return (
    <div
      role="region"
      aria-label="Regulatory registrations"
      className="border-b border-white/10 bg-[#0b0d12] px-4 py-2.5 text-xs text-white/82 sm:text-[13px] sm:py-3"
    >
      <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-center gap-x-6 gap-y-1.5 sm:justify-between">
        <span className="inline-flex items-center gap-2">
          <BadgeCheck className="h-3.5 w-3.5 text-[#a5b4fc]" aria-hidden="true" />
          <span>
            NCR-registered Credit Provider ·{" "}
            <strong className="text-white">{identity.ncrNumber}</strong>
          </span>
        </span>
        {identity.fspNumber && (
          <span className="inline-flex items-center gap-2">
            <ShieldCheck className="h-3.5 w-3.5 text-[#a5b4fc]" aria-hidden="true" />
            <span>
              FAIS-authorised FSP ·{" "}
              <strong className="text-white">{identity.fspNumber}</strong>
            </span>
          </span>
        )}
        {demoNote && <span className="font-semibold text-white">{demoNote}</span>}
      </div>
    </div>
  )
}
