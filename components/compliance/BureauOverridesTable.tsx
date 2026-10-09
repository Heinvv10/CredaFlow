"use client"

import Link from "next/link"
import { formatDate } from "@/lib/utils"

export type BureauOverrideRow = {
  applicationId: string
  reference: string
  status: string
  clientName: string
  clientIdMasked: string
  overrideAt: Date | string
  overrideByName: string
  overrideReason: string
}

const STATUS_COLORS: Record<string, string> = {
  APPROVED: "bg-green-100 text-green-800",
  DISBURSED: "bg-blue-100 text-blue-800",
  SUBMITTED: "bg-amber-100 text-amber-800",
  UNDER_REVIEW: "bg-amber-100 text-amber-800",
  DECLINED: "bg-red-100 text-red-800",
  CANCELLED: "bg-gray-100 text-gray-800",
  DRAFT: "bg-gray-100 text-gray-800",
}

export function BureauOverridesTable({ rows }: { rows: BureauOverrideRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="bg-white rounded-2xl shadow-sm p-8 text-center text-sm text-gray-500">
        No bureau s.81 overrides match these filters.
      </div>
    )
  }

  return (
    <div className="bg-white rounded-2xl shadow-sm overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-gray-50 text-gray-500 text-xs uppercase tracking-wide">
          <tr>
            <th scope="col" className="text-left px-4 py-3 font-semibold">Reference</th>
            <th scope="col" className="text-left px-4 py-3 font-semibold">Client</th>
            <th scope="col" className="text-left px-4 py-3 font-semibold">Status</th>
            <th scope="col" className="text-left px-4 py-3 font-semibold">Override at</th>
            <th scope="col" className="text-left px-4 py-3 font-semibold">By</th>
            <th scope="col" className="text-left px-4 py-3 font-semibold">Reason</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.applicationId} className="border-t border-gray-100">
              <td className="px-4 py-3 font-mono text-xs">
                <Link
                  href={`/applications/${r.applicationId}`}
                  className="text-[#4F46E5] hover:underline"
                >
                  {r.reference}
                </Link>
              </td>
              <td className="px-4 py-3">
                <div className="font-medium text-gray-900">{r.clientName}</div>
                <div className="text-xs text-gray-500 font-mono">{r.clientIdMasked}</div>
              </td>
              <td className="px-4 py-3">
                <span
                  className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${
                    STATUS_COLORS[r.status] ?? "bg-gray-100 text-gray-800"
                  }`}
                >
                  {r.status}
                </span>
              </td>
              <td className="px-4 py-3 text-xs text-gray-600">{formatDate(r.overrideAt)}</td>
              <td className="px-4 py-3 text-xs text-gray-700">{r.overrideByName}</td>
              <td className="px-4 py-3 text-xs text-gray-700 max-w-md">{r.overrideReason}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
