"use client"

import type { ReactNode } from "react"
import { FieldGroup } from "@/components/wizard/FieldGroup"
import { displayCents } from "./formatters"
import type {
  ApplicationProduct,
  ApplicationWizardData,
  Client,
  WizardMode,
} from "./types"
import type { ValidationErrors } from "@/lib/validation/application-wizard"
import {
  calculateCreditLifeMonthlyPremiumCents,
  creditLifePrincipalIsEligible,
  type CreditLifePresentedOffer,
} from "@/lib/insurance/credit-life-election"
import { formatZAR } from "@/lib/utils"

interface StepProps {
  data: ApplicationWizardData
  patch: (partial: Partial<ApplicationWizardData>) => void
  errors: ValidationErrors<ApplicationWizardData>
  // Reserved for portal-mode conditional rendering.
  mode: WizardMode
  editJump: (n: 1 | 2 | 3) => void
  clients: Client[]
  products: ApplicationProduct[]
  creditLifeOffer: CreditLifePresentedOffer | null
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="grid grid-cols-3 gap-3 text-sm py-1">
      <dt className="text-[var(--cf-text-muted)]">{label}</dt>
      <dd className="col-span-2 text-[var(--cf-text)]">
        {value || <span className="text-[var(--cf-text-muted)]">—</span>}
      </dd>
    </div>
  )
}

function Section({
  title,
  step,
  editJump,
  children,
}: {
  title: string
  step: 1 | 2 | 3
  editJump: (n: 1 | 2 | 3) => void
  children: ReactNode
}) {
  return (
    <section className="bg-[var(--cf-bg-panel)] border border-[var(--cf-border-subtle)] rounded-xl p-4">
      <header className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold text-[var(--cf-text)]">{title}</h3>
        <button
          type="button"
          onClick={() => editJump(step)}
          className="text-xs text-[var(--cf-brand)] hover:text-[var(--cf-brand-alt)]"
        >
          Edit
        </button>
      </header>
      <dl>{children}</dl>
    </section>
  )
}

export function Step4Review({
  data,
  patch,
  errors,
  editJump,
  clients,
  products,
  creditLifeOffer,
}: StepProps) {
  // A DEFERRED initiation fee is folded into instalment 1, so it can exceed the
  // level instalment. Only then is there a "first" and a "thereafter".
  const hasFeeLoadedFirst = Boolean(data.firstInstalment) && data.firstInstalment !== data.monthlyInstalment
  const client = clients.find((c) => c.id === data.clientId)
  const product = products.find((p) => p.id === data.productId)
  const principalCents = Math.round(Number(data.appliedAmount) * 100)
  const creditLifePremiumCents = Number.isSafeInteger(principalCents) && principalCents > 0
    ? calculateCreditLifeMonthlyPremiumCents(principalCents)
    : 0
  const creditLifeAvailable =
    creditLifeOffer?.autoBundleEnabled === true
    && creditLifePrincipalIsEligible(principalCents)

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold text-[var(--cf-text)]">Review &amp; submit</h2>

      <Section title="Client" step={1} editJump={editJump}>
        <Row
          label="Client"
          value={
            client
              ? `${client.firstName} ${client.lastName} (${client.email})`
              : ""
          }
        />
      </Section>

      <Section title="Loan parameters" step={2} editJump={editJump}>
        <Row label="Product" value={product?.name ?? ""} />
        <Row label="Amount" value={`R ${Number(data.appliedAmount).toLocaleString("en-ZA")}`} />
        <Row label="Term" value={`${data.appliedTermDays} days`} />
        <Row label="Purpose" value={data.purpose} />
        {data.purposeDetails && <Row label="Details" value={data.purposeDetails} />}
      </Section>

      <Section title="Affordability" step={3} editJump={editJump}>
        {/* Instalment 1 differs whenever a DEFERRED initiation fee is folded
            into it, so state it rather than quoting only the level figure —
            this block sits directly above the NCA §92 acknowledgement. */}
        {hasFeeLoadedFirst && <Row label="First instalment" value={displayCents(data.firstInstalment)} />}
        {/* "thereafter" only means something when a different FIRST instalment
            was shown above it — a single-payment loan has no thereafter. */}
        <Row
          label={hasFeeLoadedFirst ? "Instalments thereafter" : "Instalment"}
          value={displayCents(data.monthlyInstalment)}
        />
        <Row label="Total interest" value={displayCents(data.totalInterest)} />
        {/* Fee lines make the total FOOT against the Amount shown above. The
            §92 quotation checkbox sits directly below this block — staff cannot
            confirm a cost of credit they were never shown. Excludes any bundled
            credit-life premium, which the PASQ discloses separately. */}
        <Row label="Initiation fee" value={displayCents(data.initiationFee)} />
        <Row label="Service fees" value={displayCents(data.serviceFees)} />
        <Row label="Total repayable" value={displayCents(data.totalRepayable)} />
        <Row label="Flag" value={data.affordabilityFlag} />
      </Section>

      <div className="space-y-3">
        {/* No configured credit-life product means there is no cover to offer,
            so there is no election for the client to make. Rendering a disabled
            radio pair would present a choice that does not exist; the server
            records the no-offer disclosure instead. */}
        {creditLifeOffer && (
        <section className="rounded-xl border border-[var(--cf-border-subtle)] bg-[var(--cf-bg-panel)] p-4 space-y-3">
          <div>
            <h3 className="text-sm font-semibold text-[var(--cf-text)]">Credit life election</h3>
            {creditLifeAvailable ? (
              <p className="mt-1 text-xs text-[var(--cf-text-muted)]">
                {creditLifeOffer.productName} · {creditLifeOffer.insurerName} · exact monthly premium{" "}
                <span className="font-semibold text-[var(--cf-text)]">
                  {formatZAR(creditLifePremiumCents)}
                </span>
              </p>
            ) : (
              <p className="mt-1 text-xs text-[var(--cf-text-muted)]">
                Credit-life cover is not available for this application. The client may
                proceed without cover.
              </p>
            )}
          </div>
          <FieldGroup label="" error={errors.creditLifeElection}>
            <div className="space-y-2 text-sm text-[var(--cf-text)]">
              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="creditLifeElection"
                  value="ACCEPTED"
                  checked={data.creditLifeElection === "ACCEPTED"}
                  disabled={!creditLifeAvailable}
                  onChange={() => patch({
                    creditLifeElection: "ACCEPTED",
                    creditLifeDisclosureAcknowledged: false,
                  })}
                  className="mt-1 accent-[var(--cf-brand)]"
                />
                <span>Add the offered credit-life cover.</span>
              </label>
              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="creditLifeElection"
                  value="DECLINED"
                  checked={data.creditLifeElection === "DECLINED"}
                  onChange={() => patch({
                    creditLifeElection: "DECLINED",
                    creditLifeDisclosureAcknowledged: false,
                  })}
                  className="mt-1 accent-[var(--cf-brand)]"
                />
                <span>
                  {creditLifeAvailable
                    ? "Decline the offered bundled cover."
                    : "Proceed without credit-life cover."}
                </span>
              </label>
            </div>
          </FieldGroup>
          <FieldGroup label="" error={errors.creditLifeDisclosureAcknowledged}>
            <label className="flex items-start gap-2 text-sm text-[var(--cf-text)] cursor-pointer">
              <input
                type="checkbox"
                checked={data.creditLifeDisclosureAcknowledged}
                disabled={
                  !data.creditLifeElection
                  || (!creditLifeAvailable && data.creditLifeElection !== "DECLINED")
                }
                onChange={(e) => patch({
                  creditLifeDisclosureAcknowledged: e.target.checked,
                })}
                className="mt-1 accent-[var(--cf-brand)]"
              />
              <span>
                {creditLifeAvailable
                  ? "The client was shown the product, insurer, exact monthly premium and their selected option before PASQ generation."
                  : "The client understands that this application will proceed without credit-life cover before PASQ generation."}
              </span>
            </label>
          </FieldGroup>
        </section>
        )}

        <FieldGroup label="" error={errors.pasqAcknowledged}>
          <label className="flex items-start gap-2 text-sm text-[var(--cf-text)] cursor-pointer">
            <input
              type="checkbox"
              checked={data.pasqAcknowledged}
              // Only chained behind the credit-life acknowledgement when there
              // was an offer to acknowledge; with no product configured the
              // election block is not rendered at all.
              disabled={Boolean(creditLifeOffer) && !data.creditLifeDisclosureAcknowledged}
              onChange={(e) => patch({ pasqAcknowledged: e.target.checked })}
              className="mt-1 accent-[var(--cf-brand)]"
            />
            <span>
              The client understands that a versioned Pre-Agreement Statement
              &amp; Quotation will be generated during review and must be opened
              and acknowledged in the client portal before approval. This is
              not the PASQ acknowledgement.
            </span>
          </label>
        </FieldGroup>

        <FieldGroup label="" error={errors.affordabilityDeclared}>
          <label className="flex items-start gap-2 text-sm text-[var(--cf-text)] cursor-pointer">
            <input
              type="checkbox"
              checked={data.affordabilityDeclared}
              onChange={(e) => patch({ affordabilityDeclared: e.target.checked })}
              className="mt-1 accent-[var(--cf-brand)]"
            />
            <span>
              I have completed the affordability assessment with the client and
              the information captured above is accurate (NCA §81 declaration).
            </span>
          </label>
        </FieldGroup>

        {data.affordabilityFlag === "FAIL" && (
          <FieldGroup label="" error={errors.recklessLendingConfirmed}>
            <label className="flex items-start gap-2 text-sm text-[var(--cf-text)] cursor-pointer">
              <input
                type="checkbox"
                checked={data.recklessLendingConfirmed}
                onChange={(e) => patch({ recklessLendingConfirmed: e.target.checked })}
                className="mt-1 accent-[var(--cf-brand)]"
              />
              <span>
                Reckless-lending risk acknowledged (re-confirmed from Step 3).
              </span>
            </label>
          </FieldGroup>
        )}
      </div>
    </div>
  )
}
