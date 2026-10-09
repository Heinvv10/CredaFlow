import { formatZAR, formatDateTime } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table"
import { debtAccountTypeLabel } from "@/lib/credit/debt-account-types"

interface ExpenseBreakdown {
  housing: number
  transport: number
  food: number
  education: number
  insurance: number
  clothing: number
  entertainment: number
  medical: number
  other: number
}

interface DebtObligation {
  id: string
  creditProvider: string
  accountType: string
  outstandingBalance: number
  monthlyInstalment: number
}

interface Props {
  kycStatus: string
  kycVerificationMethod: string | null
  kycVerifiedAt: Date | null
  amlScreeningStatus: string
  amlScreeningAt: Date | null
  popiaConsentGiven: boolean
  popiaConsentAt: Date | null
  expenseBreakdown: ExpenseBreakdown | null
  debtObligations: DebtObligation[]
  totalDebtRepayments: number
}

const kycColors: Record<string, string> = {
  PENDING: "bg-amber-100 text-amber-800", VERIFIED: "bg-green-100 text-green-800",
  FAILED: "bg-red-100 text-red-800", EXPIRED: "bg-gray-100 text-gray-800",
}
const amlColors: Record<string, string> = {
  NOT_REQUIRED: "bg-gray-100 text-gray-800", PENDING: "bg-amber-100 text-amber-800",
  CLEARED: "bg-green-100 text-green-800", FLAGGED: "bg-red-100 text-red-800",
}

export function ComplianceTab({
  kycStatus, kycVerificationMethod, kycVerifiedAt,
  amlScreeningStatus, amlScreeningAt,
  popiaConsentGiven, popiaConsentAt,
  expenseBreakdown: eb, debtObligations, totalDebtRepayments,
}: Props) {
  return (
    <div className="space-y-6">
      {eb && (
        <div className="bg-white rounded-lg shadow-sm p-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-4">Expense Breakdown</h3>
          <Table>
            <TableHeader><TableRow><TableHead>Category</TableHead><TableHead>Amount</TableHead></TableRow></TableHeader>
            <TableBody>
              {[
                { label: "Housing/Rent", value: eb.housing },
                { label: "Transport", value: eb.transport },
                { label: "Food & Groceries", value: eb.food },
                { label: "Education", value: eb.education },
                { label: "Insurance", value: eb.insurance },
                { label: "Clothing", value: eb.clothing },
                { label: "Entertainment", value: eb.entertainment },
                { label: "Medical", value: eb.medical },
                { label: "Other", value: eb.other },
              ].map((row) => (
                <TableRow key={row.label}><TableCell>{row.label}</TableCell><TableCell>{formatZAR(row.value)}</TableCell></TableRow>
              ))}
              <TableRow className="font-semibold">
                <TableCell>Total</TableCell>
                <TableCell>{formatZAR(eb.housing + eb.transport + eb.food + eb.education + eb.insurance + eb.clothing + eb.entertainment + eb.medical + eb.other)}</TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>
      )}

      {debtObligations.length > 0 && (
        <div className="bg-white rounded-lg shadow-sm p-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-4">Existing Debt Obligations</h3>
          <Table>
            <TableHeader><TableRow><TableHead>Provider</TableHead><TableHead>Type</TableHead><TableHead>Balance</TableHead><TableHead>Monthly</TableHead></TableRow></TableHeader>
            <TableBody>
              {debtObligations.map((d) => (
                <TableRow key={d.id}><TableCell>{d.creditProvider}</TableCell><TableCell>{debtAccountTypeLabel(d.accountType)}</TableCell><TableCell>{formatZAR(d.outstandingBalance)}</TableCell><TableCell>{formatZAR(d.monthlyInstalment)}</TableCell></TableRow>
              ))}
              <TableRow className="font-semibold"><TableCell colSpan={3}>Total Monthly</TableCell><TableCell>{formatZAR(totalDebtRepayments)}</TableCell></TableRow>
            </TableBody>
          </Table>
        </div>
      )}

      <div className="bg-white rounded-lg shadow-sm p-6">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">Compliance Status</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 text-sm">
          <div className="p-3 bg-gray-50 rounded">
            <p className="text-gray-500">POPIA Consent</p>
            <p className="font-medium">{popiaConsentGiven ? `Granted ${popiaConsentAt ? formatDateTime(popiaConsentAt) : ""}` : "Not given"}</p>
          </div>
          <div className="p-3 bg-gray-50 rounded">
            <p className="text-gray-500">KYC Verification</p>
            <p className="font-medium">
              <Badge className={kycColors[kycStatus]}>{kycStatus}</Badge>
              {kycVerificationMethod && <span className="ml-2">{kycVerificationMethod}</span>}
              {kycVerifiedAt && <span className="ml-2 text-gray-400">{formatDateTime(kycVerifiedAt)}</span>}
            </p>
          </div>
          <div className="p-3 bg-gray-50 rounded">
            <p className="text-gray-500">AML Screening</p>
            <p className="font-medium">
              <Badge className={amlColors[amlScreeningStatus]}>{amlScreeningStatus.replace("_", " ")}</Badge>
              {amlScreeningAt && <span className="ml-2 text-gray-400">{formatDateTime(amlScreeningAt)}</span>}
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
