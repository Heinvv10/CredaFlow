"use client"

import { formatZAR } from "@/lib/utils"
import type { CreditLifeElection, CreditLifePresentedOffer } from "@/lib/insurance/credit-life-election"

/**
 * The credit-life election on the portal apply form. The wording is consent
 * text and stays English (lib/i18n/.claude.md).
 *
 * When cover is not available for this application (auto-bundling off, or a
 * principal at or below the threshold) there is no choice to make, so no
 * election radios are shown — a disabled "Add the offered cover" next to
 * "not available" contradicted itself (Fair Score audit). Only the
 * acknowledgement that the application proceeds without cover remains.
 */
export function CreditLifeElectionBox({
  offer,
  available,
  monthlyPremiumCents,
  election,
  onElect,
  acknowledged,
  onAcknowledge,
}: {
  offer: CreditLifePresentedOffer
  available: boolean
  monthlyPremiumCents: number
  election: CreditLifeElection | ""
  onElect: (election: CreditLifeElection) => void
  acknowledged: boolean
  onAcknowledge: (acknowledged: boolean) => void
}) {
  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 space-y-3">
      <div>
        <p className="text-sm font-semibold text-gray-900">Credit life election</p>
        {available ? (
          <p className="mt-1 text-xs text-gray-600">
            {offer.productName} · {offer.insurerName} · exact monthly
            premium <span className="font-semibold">{formatZAR(monthlyPremiumCents)}</span>
          </p>
        ) : (
          <p className="mt-1 text-xs text-gray-600">
            Credit-life cover is not available for this application. You may
            proceed without cover.
          </p>
        )}
      </div>
      {available && (
        <>
          <label className="flex items-start gap-3 text-sm text-gray-700 cursor-pointer">
            <input
              type="radio"
              name="creditLifeElection"
              checked={election === "ACCEPTED"}
              onChange={() => onElect("ACCEPTED")}
              className="mt-1 h-4 w-4 accent-[#4F46E5]"
            />
            <span>Add the offered credit-life cover.</span>
          </label>
          <label className="flex items-start gap-3 text-sm text-gray-700 cursor-pointer">
            <input
              type="radio"
              name="creditLifeElection"
              checked={election === "DECLINED"}
              onChange={() => onElect("DECLINED")}
              className="mt-1 h-4 w-4 accent-[#4F46E5]"
            />
            <span>Decline the offered bundled cover.</span>
          </label>
        </>
      )}
      <label className="flex items-start gap-3 text-sm text-gray-700 cursor-pointer">
        <input
          type="checkbox"
          checked={acknowledged}
          disabled={available && !election}
          onChange={(e) => onAcknowledge(e.target.checked)}
          className="mt-1 h-4 w-4 accent-[#4F46E5]"
        />
        <span>
          {available
            ? "I confirm I was shown the product, insurer, exact monthly premium and selected option before PASQ generation."
            : "I understand that this application will proceed without credit-life cover before PASQ generation."}
        </span>
      </label>
    </div>
  )
}
