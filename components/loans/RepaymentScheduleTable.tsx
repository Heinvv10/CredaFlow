"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { formatZAR, formatDate } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { toast } from "@/lib/toast"
import { scheduleDisplayStatus } from "@/lib/loan/schedule-status"
import { AlertTriangle, RotateCcw, Loader2 } from "lucide-react"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

// ── Types ──────────────────────────────────────────────────────────────────────

interface ScheduleItem {
  id: string
  installmentNo: number
  dueDate: Date | string
  principalDue: number
  interestDue: number
  feesDue: number
  totalDue: number
  totalPaid: number
  status: string
  paidAt: Date | string | null
}

interface RepaymentScheduleTableProps {
  loanId: string
  schedule: ScheduleItem[]
  /** If false, admin action buttons are hidden (e.g. on completed/written-off loans) */
  allowAdminActions?: boolean
  /** Badge text per displayed status (scheduleDisplayStatus; serialisable: a server page passes it); the raw status when absent. */
  statusLabels?: Record<string, string>
}

// ── Helpers ────────────────────────────────────────────────────────────────────

const STATUS_BADGE: Record<string, string> = {
  UPCOMING:   "bg-gray-100 text-gray-800",
  DUE:        "bg-amber-100 text-amber-800",
  PARTIAL:    "bg-amber-100 text-amber-800",
  PAID:       "bg-green-100 text-green-800",
  OVERDUE:    "bg-red-100 text-red-800",
  WRITTEN_OFF:"bg-gray-100 text-gray-500",
  CANCELLED:  "bg-gray-100 text-gray-500",
}

// ── Component ──────────────────────────────────────────────────────────────────

export function RepaymentScheduleTable({
  loanId,
  schedule,
  allowAdminActions = true,
  statusLabels = {},
}: RepaymentScheduleTableProps) {
  const router = useRouter()
  const [busyId, setBusyId] = useState<string | null>(null)
  const now = new Date()

  async function runAction(scheduleId: string, action: "flag_missed" | "revert") {
    setBusyId(scheduleId)
    try {
      const res = await fetch(`/api/loans/${loanId}/schedule/${scheduleId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      })
      const data = await res.json() as { ok?: boolean; error?: string }
      if (!res.ok || !data.ok) {
        toast.error("Action failed", data.error ?? "Could not update instalment.")
        return
      }
      const labels: Record<string, string> = {
        flag_missed: "Flagged as overdue",
        revert:      "Overdue flag removed",
      }
      toast.success(labels[action] ?? "Updated")
      router.refresh()
    } catch {
      toast.error("Network error", "Could not reach the server.")
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="bg-white rounded-lg shadow-sm">
      <div className="p-6 border-b border-gray-100">
        <h3 className="text-lg font-semibold text-gray-900">Repayment Schedule</h3>
        {allowAdminActions && (
          <p className="text-xs text-gray-400 mt-0.5">
            Admin actions: flag an instalment as missed, or remove the flag. Payments are recorded as receipts.
          </p>
        )}
      </div>
      {/* min-width forces the 9-column schedule to overflow (and the Table's
          own overflow-auto wrapper to scroll) rather than crushing every header
          to one character per line on mobile (audit N-08). */}
      <Table className="min-w-[760px]">
        <TableHeader>
          <TableRow>
            <TableHead>#</TableHead>
            <TableHead>Due Date</TableHead>
            <TableHead>Principal</TableHead>
            <TableHead>Interest</TableHead>
            <TableHead>Fees</TableHead>
            <TableHead>Total Due</TableHead>
            <TableHead>Paid</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Paid Date</TableHead>
            {allowAdminActions && <TableHead>Admin</TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {schedule.map((item) => {
            const isBusy = busyId === item.id
            const shown = scheduleDisplayStatus(item, now)
            return (
              <TableRow key={item.id}>
                <TableCell>{item.installmentNo}</TableCell>
                <TableCell>{formatDate(item.dueDate)}</TableCell>
                <TableCell>{formatZAR(item.principalDue)}</TableCell>
                <TableCell>{formatZAR(item.interestDue)}</TableCell>
                <TableCell>{formatZAR(item.feesDue)}</TableCell>
                <TableCell className="font-medium">{formatZAR(item.totalDue)}</TableCell>
                <TableCell className={item.totalPaid > 0 ? "text-green-600" : ""}>
                  {formatZAR(item.totalPaid)}
                </TableCell>
                <TableCell>
                  <Badge className={STATUS_BADGE[shown] ?? "bg-gray-100 text-gray-800"}>
                    {statusLabels[shown] ?? shown}
                  </Badge>
                </TableCell>
                <TableCell>
                  {item.paidAt ? formatDate(item.paidAt) : "—"}
                </TableCell>
                {allowAdminActions && (
                  <TableCell>
                    <div className="flex items-center gap-1">
                      {isBusy ? (
                        <Loader2 className="h-4 w-4 animate-spin text-gray-400" />
                      ) : (
                        <>
                          {item.status !== "OVERDUE" && item.status !== "WRITTEN_OFF" && item.status !== "CANCELLED" && item.status !== "PAID" && (
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 px-2 text-red-600 border-red-300 hover:bg-red-50"
                              title="Flag as missed/overdue"
                              onClick={() => runAction(item.id, "flag_missed")}
                            >
                              <AlertTriangle className="h-3 w-3" />
                            </Button>
                          )}
                          {item.status === "OVERDUE" && (
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 px-2 text-gray-500 hover:bg-gray-50"
                              title="Remove overdue flag"
                              onClick={() => runAction(item.id, "revert")}
                            >
                              <RotateCcw className="h-3 w-3" />
                            </Button>
                          )}
                        </>
                      )}
                    </div>
                  </TableCell>
                )}
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </div>
  )
}
