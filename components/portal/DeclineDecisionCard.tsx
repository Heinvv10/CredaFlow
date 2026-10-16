import type { PortalDeclineView } from "@/lib/portal/decline-view"

/** The decline decision as the borrower sees it. English in every locale: it is the decision record. */
export function DeclineDecisionCard({ view }: { view: PortalDeclineView }) {
  return (
    <div lang="en" className="mb-5 rounded-xl border border-red-200 bg-red-50 p-4">
      <p className="mb-1 text-sm font-semibold text-red-800">Reason for Decision</p>
      <p className="text-sm text-red-700">{view.reason}</p>
      {view.bureau && (
        <div className="mt-3 rounded-lg border border-red-200 bg-white/60 p-3 text-sm text-red-800">
          <p>
            This decision was based on information from the credit bureau{" "}
            <span className="font-semibold">{view.bureau.name}</span>.
          </p>
          {(view.bureau.phone || view.bureau.website) && (
            <p className="mt-1">
              Contact {view.bureau.name}
              {view.bureau.phone && <> on <span className="font-semibold">{view.bureau.phone}</span></>}
              {view.bureau.phone && view.bureau.website && " or"}
              {view.bureau.website && <> at <span className="font-semibold">{view.bureau.website}</span></>}
              {" "}for your credit report.
            </p>
          )}
        </div>
      )}
      <p className="mt-3 text-sm font-semibold text-red-800">What you can do next</p>
      <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-red-700">
        {view.nextSteps.map((step) => <li key={step}>{step}</li>)}
      </ul>
    </div>
  )
}
