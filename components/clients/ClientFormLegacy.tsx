"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "@/lib/toast"
import { SA_BANKS, toBankCode } from "@/lib/banks"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { ExpenseBreakdownSection, type ExpenseBreakdownData } from "./ExpenseBreakdownSection"
import { DebtObligationsSection, type DebtObligation } from "./DebtObligationsSection"
import { centsToRandExpenses, centsToRandDebts, randsToCents } from "./client-edit-money"
import { ReferralAgentField, type ReferralImpactSummary } from "./ReferralAgentField"
import { referralPayloadFields, isReferralSaveBlocked } from "./client-referral-payload"
import { cn } from "@/lib/utils"
import { UNEMPLOYED_STATUSES } from "@/lib/validation/client-wizard"

interface ClientFormProps {
  /** LOAN_ADMIN-and-up may re-point referral commission; see ReferralAgentField. */
  canEditReferralAgent?: boolean
  initialData?: {
    id?: string
    updatedAt?: string
    firstName: string
    lastName: string
    idNumber: string
    dateOfBirth?: string
    gender?: string
    email: string
    phone: string
    whatsapp?: string
    addressLine1?: string
    suburb?: string
    city?: string
    province?: string
    postalCode?: string
    employmentStatus?: string
    employerName?: string
    employerAddress?: string
    monthlyIncome: number
    grossMonthlyIncome?: number
    incomeSourceType?: string
    employmentStartDate?: string
    salaryPaymentDay?: number
    monthlyExpenses: number
    bankName?: string
    bankAccountNumber?: string
    bankBranchCode?: string
    accountType?: string
    nextOfKinName?: string
    nextOfKinPhone?: string
    nextOfKinRelationship?: string
    popiaConsentGiven?: boolean
    referralCodeId?: string | null
    referralCodeLabel?: string | null
    expenseBreakdown?: ExpenseBreakdownData
    debtObligations?: DebtObligation[]
  }
}

const EXPENSE_KEYS = [
  "housing", "transport", "food", "education", "insurance",
  "clothing", "entertainment", "medical", "other",
] as const

const WORKFLOW_STEPS = [
  "Identity",
  "Contact",
  "Affordability",
  "Banking",
  "Compliance",
]

export function ClientForm({ initialData, canEditReferralAgent = false }: ClientFormProps) {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  // A stored bank outside SA_BANKS (a real one we do not list yet, e.g. Sasfin)
  // is offered as its own option so it round-trips. Without it the picker shows
  // the placeholder, and saving submits "" which the update route stores as
  // null — turning "silently the wrong bank" into "silently no bank". Both are
  // the same defect: saving changes a field nobody touched.
  const unlistedBank = toBankCode(initialData?.bankName)
    ? null
    : initialData?.bankName?.trim() || null
  const [employmentStatus, setEmploymentStatus] = useState(initialData?.employmentStatus || "")
  const [expenses, setExpenses] = useState<ExpenseBreakdownData>(centsToRandExpenses(initialData?.expenseBreakdown))
  const [debts, setDebts] = useState<DebtObligation[]>(centsToRandDebts(initialData?.debtObligations))
  const [popiaConsent, setPopiaConsent] = useState(initialData?.popiaConsentGiven || false)
  // The previewed commission impact of a pending referral change, or null when
  // there is none. Its totals are echoed back on save so the server can refuse
  // to write a figure other than the one shown here (the preview and the write
  // build separate plans, and a rate change between them would otherwise swap
  // one for the other silently). `blocked` means the server refuses the move
  // outright — ReferralAgentField names the way out on screen.
  const [referralImpact, setReferralImpact] = useState<ReferralImpactSummary | null>(null)
  const [idNumber, setIdNumber] = useState(initialData?.idNumber || "")
  const [dobFromId, setDobFromId] = useState(initialData?.dateOfBirth || "")
  const [genderFromId, setGenderFromId] = useState(initialData?.gender || "")

  // Complement of the wizard's set rather than its own allow-list, so adding a
  // status in one place cannot silently hide employer fields in the other.
  // PART_TIME earns from an employer on a pay day, so it belongs here.
  const isEmployed = employmentStatus !== "" && !UNEMPLOYED_STATUSES.has(employmentStatus)

  const handleIdNumberChange = (val: string) => {
    const clean = val.replace(/\D/g, "").slice(0, 13)
    setIdNumber(clean)
    if (clean.length >= 7) {
      // Extract DOB: YYMMDD
      const yy = clean.slice(0, 2)
      const mm = clean.slice(2, 4)
      const dd = clean.slice(4, 6)
      // sast-exempt: this is a "use client" component, so the getter runs in
      // the staff member's browser, which is already in SAST. (The SERVER
      // copy of this century inference, in lib/validation/client-wizard.ts,
      // is NOT exempt — there the container is UTC and an ID whose two-digit
      // year equals the incoming year is misread by a century for two hours
      // on 1 January.)
    const year = parseInt(yy) <= new Date().getFullYear() % 100 ? `20${yy}` : `19${yy}`
      const month = parseInt(mm)
      const day = parseInt(dd)
      if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
        setDobFromId(`${year}-${mm}-${dd}`)
      }
      // Extract gender: digits 7-10, 0000-4999 = Female, 5000-9999 = Male
      const seq = parseInt(clean.slice(6, 10))
      if (!isNaN(seq)) {
        setGenderFromId(seq >= 5000 ? "MALE" : "FEMALE")
      }
    } else {
      setDobFromId("")
      setGenderFromId("")
    }
  }

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!popiaConsent) { setError("POPIA consent is required"); return }
    setLoading(true)
    setError("")

    const fd = new FormData(e.currentTarget)
    const data = {
      ...(initialData?.id && { expectedUpdatedAt: initialData.updatedAt }),
      firstName: fd.get("firstName"), lastName: fd.get("lastName"),
      idNumber: idNumber, dateOfBirth: dobFromId || null,
      gender: genderFromId || fd.get("gender") || null, email: fd.get("email"),
      phone: fd.get("phone"), whatsapp: fd.get("whatsapp") || null,
      addressLine1: fd.get("addressLine1") || null, suburb: fd.get("suburb") || null,
      city: fd.get("city") || null, province: fd.get("province") || null,
      postalCode: fd.get("postalCode") || null,
      employmentStatus: fd.get("employmentStatus") || null,
      employerName: fd.get("employerName") || null,
      employerAddress: fd.get("employerAddress") || null,
      // Blank gross income is unknown, not zero. Persisting a blank as 0 made
      // the Regulation 23A MLE calculator treat R0 as the authoritative basis
      // instead of falling back to the declared net income.
      grossMonthlyIncome: fd.get("grossMonthlyIncome")
        ? randsToCents(fd.get("grossMonthlyIncome"))
        : null,
      monthlyIncome: randsToCents(fd.get("monthlyIncome")),
      incomeSourceType: fd.get("incomeSourceType") || null,
      employmentStartDate: fd.get("employmentStartDate") || null,
      salaryPaymentDay: parseInt(fd.get("salaryPaymentDay") as string) || null,
      monthlyExpenses: EXPENSE_KEYS.reduce((sum, key) => sum + randsToCents(expenses[key]), 0),
      bankName: fd.get("bankName") || null,
      bankAccountNumber: fd.get("bankAccountNumber") || null,
      bankBranchCode: fd.get("bankBranchCode") || null,
      accountType: fd.get("accountType") || null,
      nextOfKinName: fd.get("nextOfKinName") || null,
      nextOfKinPhone: fd.get("nextOfKinPhone") || null,
      nextOfKinRelationship: fd.get("nextOfKinRelationship") || null,
      popiaConsentGiven: popiaConsent,
      // Key-presence contract AND the approved-totals binding, both in
      // client-referral-payload.ts so they are testable without rendering this
      // Radix-heavy form. The totals are what the server refuses to differ from.
      ...referralPayloadFields(fd, referralImpact),
      expenseBreakdown: {
        ...Object.fromEntries(
          EXPENSE_KEYS.map((key) => [key, randsToCents(expenses[key])]),
        ),
        belowMleJustification: expenses.belowMleJustification ?? "",
      },
      debtObligations: debts.map((d) => ({
        ...d,
        outstandingBalance: randsToCents(d.outstandingBalance),
        monthlyInstalment: randsToCents(d.monthlyInstalment),
      })),
    }

    try {
      const url = initialData?.id ? `/api/clients/${initialData.id}` : "/api/clients"
      const method = initialData?.id ? "PUT" : "POST"
      const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) })
      if (!res.ok) { const err = await res.json(); throw new Error(err.error || "Failed to save client") }
      const result = await res.json()
      if (initialData?.id) { toast.client.updated() } else { toast.client.created() }
      router.push(`/clients/${result.id}`)
      router.refresh()
    } catch (err) {
      const msg = err instanceof Error ? err.message : "An error occurred"
      setError(msg)
      toast.error(msg)
    } finally { setLoading(false) }
  }

  return (
    <form onSubmit={handleSubmit} className="grid gap-6 xl:grid-cols-[240px_1fr]">
      <aside className="hidden xl:block">
        <div className="sticky top-20 rounded-lg border border-[var(--cf-border-subtle)] bg-[var(--cf-bg-panel)] p-4">
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--cf-brand)]">Client Workflow</p>
          <div className="mt-4 space-y-3">
            {WORKFLOW_STEPS.map((step, index) => (
              <div key={step} className="flex items-center gap-3">
                <span
                  className={cn(
                    "flex h-7 w-7 items-center justify-center rounded-md text-xs font-semibold",
                    index === 0
                      ? "bg-[var(--cf-brand)] text-[var(--cf-on-brand)]"
                      : "border border-[var(--cf-border-subtle)] text-[var(--cf-text-muted)]"
                  )}
                >
                  {index + 1}
                </span>
                <span className="text-sm text-[var(--cf-text-secondary)]">{step}</span>
              </div>
            ))}
          </div>
          <p className="mt-5 text-xs leading-5 text-[var(--cf-text-muted)]">
            Capture one client record with enough KYC, affordability and consent context to support lending, insurance and collections workflows.
          </p>
        </div>
      </aside>

      <div className="space-y-8">
      {error && <div className="rounded-lg border border-[rgba(208,92,75,0.28)] bg-[rgba(208,92,75,0.10)] p-4 text-sm text-[var(--cf-danger)]">{error}</div>}

      {/* Personal Information */}
      <div className="bg-white rounded-lg shadow-sm p-6">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">Personal Information</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          <div><Label htmlFor="firstName">First Name *</Label><Input id="firstName" name="firstName" defaultValue={initialData?.firstName} required /></div>
          <div><Label htmlFor="lastName">Last Name *</Label><Input id="lastName" name="lastName" defaultValue={initialData?.lastName} required /></div>
          <div>
            <Label htmlFor="idNumber">ID Number *</Label>
            <Input
              id="idNumber"
              name="idNumber"
              value={idNumber}
              onChange={(e) => handleIdNumberChange(e.target.value)}
              required
              maxLength={13}
              placeholder="13-digit SA ID number"
              className={idNumber.length === 13 ? "border-green-400" : ""}
            />
            {idNumber.length > 0 && idNumber.length < 13 && (
              <p className="text-xs text-gray-400 mt-1">{13 - idNumber.length} digits remaining</p>
            )}
            {idNumber.length === 13 && (
              <p className="text-xs text-green-600 mt-1">✓ Valid length — DOB and gender extracted</p>
            )}
          </div>
          <div>
            <Label htmlFor="dateOfBirth">Date of Birth</Label>
            <Input
              id="dateOfBirth"
              name="dateOfBirth"
              type="date"
              value={dobFromId}
              onChange={(e) => setDobFromId(e.target.value)}
              className={dobFromId && idNumber.length === 13 ? "bg-green-50 border-green-300" : ""}
            />
            {dobFromId && idNumber.length === 13 && (
              <p className="text-xs text-green-600 mt-1">✓ Auto-filled from ID number</p>
            )}
          </div>
          <div>
            <Label htmlFor="gender">Gender</Label>
            <Select name="gender" value={genderFromId} onValueChange={setGenderFromId}>
              <SelectTrigger className={genderFromId && idNumber.length === 13 ? "bg-green-50 border-green-300" : ""}>
                <SelectValue placeholder="Select gender" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="MALE">Male</SelectItem>
                <SelectItem value="FEMALE">Female</SelectItem>
                <SelectItem value="OTHER">Other</SelectItem>
              </SelectContent>
            </Select>
            {genderFromId && idNumber.length === 13 && (
              <p className="text-xs text-green-600 mt-1">✓ Auto-filled from ID number</p>
            )}
          </div>
        </div>
      </div>

      {/* Contact Information */}
      <div className="bg-white rounded-lg shadow-sm p-6">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">Contact Information</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          <div><Label htmlFor="email">Email *</Label><Input id="email" name="email" type="email" defaultValue={initialData?.email} required /></div>
          <div><Label htmlFor="phone">Phone *</Label><Input id="phone" name="phone" defaultValue={initialData?.phone} required /></div>
          <div><Label htmlFor="whatsapp">WhatsApp</Label><Input id="whatsapp" name="whatsapp" defaultValue={initialData?.whatsapp} /></div>
        </div>
      </div>

      {/* Address */}
      <div className="bg-white rounded-lg shadow-sm p-6">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">Address</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          <div className="lg:col-span-2"><Label htmlFor="addressLine1">Street Address</Label><Input id="addressLine1" name="addressLine1" defaultValue={initialData?.addressLine1} /></div>
          <div><Label htmlFor="suburb">Suburb</Label><Input id="suburb" name="suburb" defaultValue={initialData?.suburb} /></div>
          <div><Label htmlFor="city">City</Label><Input id="city" name="city" defaultValue={initialData?.city} /></div>
          <div><Label htmlFor="province">Province</Label><Select name="province" defaultValue={initialData?.province}><SelectTrigger><SelectValue placeholder="Select province" /></SelectTrigger><SelectContent><SelectItem value="GAUTENG">Gauteng</SelectItem><SelectItem value="WESTERN_CAPE">Western Cape</SelectItem><SelectItem value="KWAZULU_NATAL">KwaZulu-Natal</SelectItem><SelectItem value="EASTERN_CAPE">Eastern Cape</SelectItem><SelectItem value="FREE_STATE">Free State</SelectItem><SelectItem value="LIMPOPO">Limpopo</SelectItem><SelectItem value="MPUMALANGA">Mpumalanga</SelectItem><SelectItem value="NORTH_WEST">North West</SelectItem><SelectItem value="NORTHERN_CAPE">Northern Cape</SelectItem></SelectContent></Select></div>
          <div><Label htmlFor="postalCode">Postal Code</Label><Input id="postalCode" name="postalCode" defaultValue={initialData?.postalCode} /></div>
        </div>
      </div>

      {/* Employment & Income */}
      <div className="bg-white rounded-lg shadow-sm p-6">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">Employment & Income</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          <div><Label htmlFor="employmentStatus">Employment Status</Label><Select name="employmentStatus" defaultValue={initialData?.employmentStatus} onValueChange={setEmploymentStatus}><SelectTrigger><SelectValue placeholder="Select status" /></SelectTrigger><SelectContent><SelectItem value="EMPLOYED">Employed</SelectItem><SelectItem value="PART_TIME">Part-time / Contract</SelectItem><SelectItem value="SELF_EMPLOYED">Self Employed</SelectItem><SelectItem value="UNEMPLOYED">Unemployed</SelectItem><SelectItem value="STUDENT">Student</SelectItem><SelectItem value="PENSIONER">Pensioner</SelectItem></SelectContent></Select></div>
          <div><Label htmlFor="employerName">Employer Name</Label><Input id="employerName" name="employerName" defaultValue={initialData?.employerName} /></div>
          <div><Label htmlFor="grossMonthlyIncome">Gross Monthly Income (R)</Label><Input id="grossMonthlyIncome" name="grossMonthlyIncome" type="number" step="0.01" min={0} defaultValue={initialData?.grossMonthlyIncome ? initialData.grossMonthlyIncome / 100 : ""} /></div>
          <div><Label htmlFor="monthlyIncome">Net/Take-home Monthly Income (R)</Label><Input id="monthlyIncome" name="monthlyIncome" type="number" step="0.01" min={0} defaultValue={initialData?.monthlyIncome ? initialData.monthlyIncome / 100 : ""} /></div>
          <div><Label htmlFor="incomeSourceType">Income Source Type</Label><Select name="incomeSourceType" defaultValue={initialData?.incomeSourceType}><SelectTrigger><SelectValue placeholder="Select source" /></SelectTrigger><SelectContent><SelectItem value="SALARY">Salary</SelectItem><SelectItem value="WAGES">Wages</SelectItem><SelectItem value="PENSION">Pension</SelectItem><SelectItem value="SOCIAL_GRANT">Social Grant</SelectItem><SelectItem value="BUSINESS_INCOME">Business Income</SelectItem><SelectItem value="RENTAL_INCOME">Rental Income</SelectItem><SelectItem value="OTHER">Other</SelectItem></SelectContent></Select></div>
          {isEmployed && (
            <>
              <div><Label htmlFor="employmentStartDate">Employment Start Date</Label><Input id="employmentStartDate" name="employmentStartDate" type="date" defaultValue={initialData?.employmentStartDate} /></div>
              <div><Label htmlFor="salaryPaymentDay">Salary Payment Day (1-31)</Label><Input id="salaryPaymentDay" name="salaryPaymentDay" type="number" min={1} max={31} defaultValue={initialData?.salaryPaymentDay} /></div>
              <div><Label htmlFor="employerAddress">Employer Address</Label><Input id="employerAddress" name="employerAddress" defaultValue={initialData?.employerAddress} /></div>
            </>
          )}
        </div>
      </div>

      <ExpenseBreakdownSection data={expenses} onChange={setExpenses} />
      <DebtObligationsSection debts={debts} onChange={setDebts} />

      {/* Banking Details */}
      <div className="bg-white rounded-lg shadow-sm p-6">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">Banking Details</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {/*
            defaultValue goes through toBankCode, and `?? undefined` is
            load-bearing. Client.bankName also holds VLM-extracted spellings
            ("First National Bank", "Capitec Bank Limited") and portal labels,
            none of which match a SelectItem value. Radix renders its FIRST
            option for an unmatched defaultValue, so passing the raw value made
            this field read "ABSA" for those clients — and saving
            the form, without touching the bank, persisted that. Resolving to a
            code shows their real bank; a bank outside the vocabulary resolves
            to null and MUST reach the Select as undefined, so it shows the
            placeholder. "Not set" is recoverable; a confidently wrong bank is
            not.
          */}
          <div><Label htmlFor="bankName">Bank Name</Label><Select name="bankName" defaultValue={toBankCode(initialData?.bankName) ?? unlistedBank ?? undefined}><SelectTrigger><SelectValue placeholder="Select bank" /></SelectTrigger><SelectContent>{SA_BANKS.map((bank) => <SelectItem key={bank.code} value={bank.code}>{bank.label}</SelectItem>)}{unlistedBank && <SelectItem value={unlistedBank}>{unlistedBank}</SelectItem>}</SelectContent></Select></div>
          <div><Label htmlFor="accountType">Account Type</Label><Select name="accountType" defaultValue={initialData?.accountType}><SelectTrigger><SelectValue placeholder="Select type" /></SelectTrigger><SelectContent><SelectItem value="CHEQUE">Cheque</SelectItem><SelectItem value="SAVINGS">Savings</SelectItem><SelectItem value="OTHER">Other</SelectItem></SelectContent></Select></div>
          <div><Label htmlFor="bankAccountNumber">Account Number</Label><Input id="bankAccountNumber" name="bankAccountNumber" defaultValue={initialData?.bankAccountNumber} /></div>
          <div><Label htmlFor="bankBranchCode">Branch Code</Label><Input id="bankBranchCode" name="bankBranchCode" defaultValue={initialData?.bankBranchCode} /></div>
        </div>
      </div>

      {/* Next of Kin */}
      <div className="bg-white rounded-lg shadow-sm p-6">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">Next of Kin</h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div><Label htmlFor="nextOfKinName">Name</Label><Input id="nextOfKinName" name="nextOfKinName" defaultValue={initialData?.nextOfKinName} /></div>
          <div><Label htmlFor="nextOfKinPhone">Phone</Label><Input id="nextOfKinPhone" name="nextOfKinPhone" defaultValue={initialData?.nextOfKinPhone} /></div>
          <div><Label htmlFor="nextOfKinRelationship">Relationship</Label><Select name="nextOfKinRelationship" defaultValue={initialData?.nextOfKinRelationship}><SelectTrigger><SelectValue placeholder="Select relationship" /></SelectTrigger><SelectContent><SelectItem value="Spouse">Spouse</SelectItem><SelectItem value="Parent">Parent</SelectItem><SelectItem value="Child">Child</SelectItem><SelectItem value="Sibling">Sibling</SelectItem><SelectItem value="Other">Other</SelectItem></SelectContent></Select></div>
        </div>
      </div>

      {/* Consent & Compliance */}
      <div className="bg-white rounded-lg shadow-sm p-6">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">Consent & Compliance</h3>
        <label className="flex items-start gap-3 cursor-pointer">
          <input type="checkbox" checked={popiaConsent} onChange={(e) => setPopiaConsent(e.target.checked)} className="mt-1 h-4 w-4 rounded border-gray-300" />
          <span className="text-sm text-gray-700">I consent to my personal information being processed for credit assessment purposes in accordance with POPIA *</span>
        </label>
        {initialData?.id && (
          <ReferralAgentField
            clientId={initialData.id}
            initialCodeId={initialData.referralCodeId}
            initialCodeLabel={initialData.referralCodeLabel}
            canEdit={canEditReferralAgent}
            onImpactChange={setReferralImpact}
          />
        )}
      </div>

      <div className="sticky bottom-0 z-20 -mx-4 flex justify-end gap-4 border-t border-[var(--cf-border-subtle)] bg-[rgba(11,13,18,0.92)] px-4 py-4 backdrop-blur lg:-mx-8 lg:px-8">
        <Button type="button" variant="outline" onClick={() => router.back()}>Cancel</Button>
        <Button type="submit" disabled={loading || isReferralSaveBlocked(referralImpact)}>{loading ? "Saving..." : initialData?.id ? "Update Client" : "Create Client"}</Button>
      </div>
      </div>
    </form>
  )
}
