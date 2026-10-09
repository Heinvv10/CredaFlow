"use client"

import { Check } from "lucide-react"

type AppStatus = "DRAFT" | "SUBMITTED" | "UNDER_REVIEW" | "APPROVED" | "DISBURSED" | "DECLINED" | "CANCELLED"

interface Step {
  key: string
  label: string
  sub: string
}

const STEPS: Step[] = [
  { key: "submit", label: "Submitted", sub: "Application captured" },
  { key: "kyc", label: "KYC Verified", sub: "Documents cleared" },
  { key: "afford", label: "Affordability", sub: "NDI assessed" },
  { key: "decision", label: "Credit Decision", sub: "Approved / Declined" },
  { key: "agreement", label: "Agreement", sub: "Signed & accepted" },
  { key: "disburse", label: "Disbursed", sub: "Funds released" },
]

function getActiveStep(
  status: AppStatus,
  kycVerified: boolean,
  affordabilityDone: boolean,
  recklessnessDone: boolean,
  agreementSigned: boolean,
): number {
  if (status === "DECLINED" || status === "CANCELLED") return -1
  if (status === "DISBURSED") return 6
  if (status === "APPROVED" && agreementSigned) return 5
  if (status === "APPROVED") return 4
  if (status === "UNDER_REVIEW" && affordabilityDone && recklessnessDone) return 3
  if (status === "UNDER_REVIEW" && kycVerified) return 2
  if (status === "SUBMITTED" || status === "UNDER_REVIEW") return 1
  return 0
}

interface Props {
  status: AppStatus
  kycVerified: boolean
  affordabilityDone: boolean
  recklessnessDone: boolean
  agreementSigned: boolean
}

export function PipelineStepper({ status, kycVerified, affordabilityDone, recklessnessDone, agreementSigned }: Props) {
  const isTerminal = status === "DECLINED" || status === "CANCELLED"
  const activeStep = getActiveStep(status, kycVerified, affordabilityDone, recklessnessDone, agreementSigned)

  if (isTerminal) {
    return (
      <div className="flex items-center gap-3 rounded-lg border border-[rgba(208,92,75,0.34)] bg-[rgba(208,92,75,0.08)] px-6 py-4">
        <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full border border-[rgba(208,92,75,0.34)] bg-[rgba(208,92,75,0.12)]">
          <span className="text-sm font-bold text-[var(--cf-danger)]">x</span>
        </div>
        <div>
          <p className="font-semibold text-[var(--cf-danger)]">Application {status === "DECLINED" ? "Declined" : "Cancelled"}</p>
          <p className="text-xs text-[var(--cf-text-muted)]">This application did not proceed to disbursement</p>
        </div>
      </div>
    )
  }

  return (
    <div className="rounded-lg border border-[var(--cf-border-subtle)] bg-[var(--cf-bg-panel)] px-6 py-5">
      <div className="flex items-start">
        {STEPS.map((step, i) => {
          const done = i < activeStep
          const active = i === activeStep
          const upcoming = i > activeStep

          return (
            <div key={step.key} className="flex min-w-0 flex-1 items-start">
              <div className="flex flex-shrink-0 flex-col items-center">
                <div
                  className={`flex h-8 w-8 items-center justify-center rounded-full border text-sm font-semibold transition-colors ${
                    done
                      ? "border-[rgba(63,191,127,0.5)] bg-[rgba(63,191,127,0.18)] text-[var(--cf-success)]"
                      : active
                        ? "border-[var(--cf-border-strong)] bg-[rgba(79,70,229,0.18)] text-[var(--cf-brand-soft)]"
                        : "border-[var(--cf-border-subtle)] bg-[var(--cf-bg-subtle)] text-[var(--cf-text-muted)]"
                  }`}
                >
                  {done ? <Check className="h-4 w-4" /> : <span>{i + 1}</span>}
                </div>
                <div className={`mt-2 px-1 text-center ${upcoming ? "opacity-45" : ""}`}>
                  <p className={`text-[11px] font-semibold leading-tight ${active ? "text-[var(--cf-brand-soft)]" : done ? "text-[var(--cf-success)]" : "text-[var(--cf-text-muted)]"}`}>
                    {step.label}
                  </p>
                  <p className="mt-0.5 hidden text-[10px] leading-tight text-[var(--cf-text-muted)] sm:block">{step.sub}</p>
                </div>
              </div>
              {i < STEPS.length - 1 && (
                <div className="mx-2 mt-4 min-w-0 flex-1">
                  <div className={`h-px w-full rounded ${i < activeStep ? "bg-[rgba(63,191,127,0.45)]" : "bg-[var(--cf-border-subtle)]"}`} />
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
