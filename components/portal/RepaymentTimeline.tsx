"use client"

import { useState } from "react"
import { formatZAR, SAST_TIME_ZONE } from "@/lib/utils"

interface TimelineItem {
  id: string
  installmentNo: number
  dueDate: string
  totalDue: number
  totalPaid: number
  status: string
}

interface RepaymentTimelineProps {
  items: TimelineItem[]
}

function statusColor(status: string, isNext: boolean): string {
  if (status === "PAID") return "#27AE60"
  if (status === "OVERDUE") return "#E74C3C"
  if (isNext) return "#4338CA"
  if (status === "WRITTEN_OFF") return "#888"
  return "#ccc"
}

function statusLabel(status: string, isNext: boolean): string {
  if (isNext && (status === "PENDING" || status === "PARTIAL")) return "Next"
  if (status === "PAID") return "Paid"
  if (status === "PARTIAL") return "Partial"
  if (status === "OVERDUE") return "Overdue"
  if (status === "WRITTEN_OFF") return "Written off"
  return "Upcoming"
}

function formatDueDate(dateStr: string): string {
  const d = new Date(dateStr)
  return d.toLocaleDateString("en-ZA", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: SAST_TIME_ZONE,
  })
}

export function RepaymentTimeline({ items }: RepaymentTimelineProps) {
  const [activeId, setActiveId] = useState<string | null>(null)

  const firstPendingIdx = items.findIndex(
    (i) => i.status === "PENDING" || i.status === "PARTIAL"
  )

  return (
    <>
      <style>{`
        @keyframes pulse-gold {
          0%, 100% { box-shadow: 0 0 0 0 rgba(67,56,202,0.5); }
          50% { box-shadow: 0 0 0 8px rgba(67,56,202,0); }
        }
        .timeline-pulse { animation: pulse-gold 2s ease-in-out infinite; }
      `}</style>

      {/* Desktop: horizontal scroll */}
      <div className="hidden md:block overflow-x-auto pb-4">
        <div
          className="flex items-start gap-0 min-w-max px-4"
          style={{ paddingTop: 40, paddingBottom: 20 }}
        >
          {items.map((item, idx) => {
            const isNext = idx === firstPendingIdx
            const color = statusColor(item.status, isNext)
            const filled =
              item.status === "PAID" ||
              item.status === "OVERDUE" ||
              isNext
            const isActive = activeId === item.id

            return (
              <div
                key={item.id}
                className="flex items-center"
                style={{ position: "relative" }}
              >
                {/* Connecting line (before node, except first) */}
                {idx > 0 && (
                  <div
                    className="h-0.5"
                    style={{
                      width: 48,
                      backgroundColor:
                        item.status === "PAID" || idx <= firstPendingIdx
                          ? "#4338CA"
                          : "#ddd",
                    }}
                  />
                )}

                {/* Node */}
                <button
                  onClick={() =>
                    setActiveId(isActive ? null : item.id)
                  }
                  className={`relative w-8 h-8 rounded-full border-2 flex items-center justify-center text-[10px] font-bold shrink-0 transition-colors ${isNext ? "timeline-pulse" : ""}`}
                  style={{
                    borderColor: color,
                    backgroundColor: filled ? color : "transparent",
                    color: filled ? "#fff" : color,
                    cursor: "pointer",
                  }}
                >
                  {item.installmentNo}
                </button>

                {/* Tooltip */}
                {isActive && (
                  <div
                    className="absolute z-20 bg-white rounded-xl shadow-lg border border-gray-100 p-3 text-xs"
                    style={{
                      top: -90,
                      left: "50%",
                      transform: "translateX(-50%)",
                      minWidth: 160,
                    }}
                  >
                    <p className="font-bold text-gray-900 mb-1">
                      Installment #{item.installmentNo}
                    </p>
                    <p className="text-gray-500">
                      Due: {formatDueDate(item.dueDate)}
                    </p>
                    <p className="text-gray-500">
                      Amount: {formatZAR(item.totalDue)}
                    </p>
                    <p className="text-gray-500">
                      Paid: {formatZAR(item.totalPaid)}
                    </p>
                    <span
                      className="inline-block mt-1 px-2 py-0.5 rounded text-[10px] font-semibold"
                      style={{
                        backgroundColor: color + "20",
                        color: color,
                      }}
                    >
                      {statusLabel(item.status, isNext)}
                    </span>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {/* Mobile: vertical */}
      <div className="md:hidden space-y-0">
        {items.map((item, idx) => {
          const isNext = idx === firstPendingIdx
          const color = statusColor(item.status, isNext)
          const filled =
            item.status === "PAID" ||
            item.status === "OVERDUE" ||
            isNext
          const isActive = activeId === item.id

          return (
            <div key={item.id} className="flex gap-3">
              {/* Vertical line + node */}
              <div className="flex flex-col items-center">
                <button
                  onClick={() =>
                    setActiveId(isActive ? null : item.id)
                  }
                  className={`relative w-7 h-7 rounded-full border-2 flex items-center justify-center text-[10px] font-bold shrink-0 ${isNext ? "timeline-pulse" : ""}`}
                  style={{
                    borderColor: color,
                    backgroundColor: filled ? color : "transparent",
                    color: filled ? "#fff" : color,
                    cursor: "pointer",
                  }}
                >
                  {item.installmentNo}
                </button>
                {idx < items.length - 1 && (
                  <div
                    className="w-0.5 flex-1 min-h-[24px]"
                    style={{
                      backgroundColor:
                        items[idx + 1].status === "PAID" ||
                        idx + 1 <= firstPendingIdx
                          ? "#4338CA"
                          : "#ddd",
                    }}
                  />
                )}
              </div>

              {/* Detail */}
              <div className="pb-4 flex-1">
                <button
                  onClick={() =>
                    setActiveId(isActive ? null : item.id)
                  }
                  className="text-left w-full"
                >
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-semibold text-gray-900">
                      {formatZAR(item.totalDue)}
                    </p>
                    <span
                      className="px-2 py-0.5 rounded text-[10px] font-semibold"
                      style={{
                        backgroundColor: color + "20",
                        color: color,
                      }}
                    >
                      {statusLabel(item.status, isNext)}
                    </span>
                  </div>
                  <p className="text-xs text-gray-500 mt-0.5">
                    Due {formatDueDate(item.dueDate)}
                  </p>
                </button>
                {isActive && (
                  <div className="mt-2 bg-gray-50 rounded-lg p-2 text-xs text-gray-600">
                    <p>Paid: {formatZAR(item.totalPaid)}</p>
                    <p>
                      Remaining:{" "}
                      {formatZAR(item.totalDue - item.totalPaid)}
                    </p>
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </>
  )
}
