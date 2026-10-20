"use client"

import { useState } from "react"
import { DataPanel } from "@/components/app-shell/DataPanel"
import { BorrowerStep } from "./BorrowerStep"
import { PeopleStep } from "./PeopleStep"
import { AssetStep } from "./AssetStep"
import { StructureStep } from "./StructureStep"
import type { BorrowerChoice, DealerWizardOptions } from "./types"

type Step = "borrower" | "people" | "asset" | "structure"

/**
 * The dealer's new-deal wizard: borrower → its people (a business) → asset →
 * supplier, product and structure. Each step writes through the dealer API
 * as it is completed, so a capture survives a later step's problem and can be
 * picked again. Documents, consent and submit follow on the deal page.
 */
export function NewDealWizard({ options }: { options: DealerWizardOptions }) {
  const [step, setStep] = useState<Step>("borrower")
  const [borrower, setBorrower] = useState<BorrowerChoice | null>(null)
  const [assetId, setAssetId] = useState<string | null>(null)
  const entity = borrower?.kind === "ENTITY" ? options.entities.find((e) => e.id === borrower.entityId) : undefined

  const steps: { key: Step; label: string }[] = [
    { key: "borrower", label: "Borrower" },
    ...(borrower?.kind !== "CLIENT" ? [{ key: "people" as const, label: "People" }] : []),
    { key: "asset", label: "Asset" },
    { key: "structure", label: "Structure and quote" },
  ]
  const at = steps.findIndex((s) => s.key === step)

  return (
    <div className="space-y-5">
      <ol className="flex flex-wrap gap-3 text-sm">
        {steps.map((s, i) => (
          <li key={s.key} className={i === at ? "font-semibold text-[var(--cf-text)]" : i < at ? "text-[var(--cf-success)]" : "text-[var(--cf-text-muted)]"}>
            {i + 1}. {s.label}
          </li>
        ))}
      </ol>
      {step === "borrower" ? (
        <DataPanel title="Who is buying" density="loose">
          <BorrowerStep options={options} onChosen={(choice) => {
            setBorrower(choice)
            setStep(choice.kind === "ENTITY" ? "people" : "asset")
          }} />
        </DataPanel>
      ) : null}
      {step === "people" && borrower?.kind === "ENTITY" ? (
        <DataPanel title="Directors, members and trustees" density="loose">
          <PeopleStep entityId={borrower.entityId} entityType={borrower.entityType} known={entity?.people ?? []}
            lenderAdded={entity?.lenderAddedPeople ?? 0} onDone={() => setStep("asset")} />
        </DataPanel>
      ) : null}
      {step === "asset" ? (
        <DataPanel title="The asset" density="loose">
          <AssetStep assets={options.assets} vatRateTenThousandths={options.vatRateTenThousandths} onChosen={(id) => { setAssetId(id); setStep("structure") }} />
        </DataPanel>
      ) : null}
      {step === "structure" && borrower && assetId ? (
        <DataPanel title="Structure and quote" density="loose">
          <StructureStep options={options} borrower={borrower} assetId={assetId} />
        </DataPanel>
      ) : null}
    </div>
  )
}
