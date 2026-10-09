"use client"

import { useState } from "react"
import { Mail, MessageSquare, Phone, Bell } from "lucide-react"
import { EmptyState } from "@/components/app-shell/EmptyState"
import { SAST_TIME_ZONE } from "@/lib/utils"

interface NotificationDisplay {
  id: string
  event: string
  eventLabel: string
  channel: string
  status: string
  error: string | null
  createdAt: string
}

interface NotificationTabsProps {
  items: NotificationDisplay[]
}

const CHANNEL_LABELS: Record<string, string> = {
  SMS: "SMS",
  EMAIL: "Email",
  WHATSAPP: "WhatsApp",
}

// NotificationLog.status is stored lowercase (e.g. "sent", "failed"). Map the
// known values to friendly labels; anything else falls back to capitalised.
const STATUS_LABELS: Record<string, string> = {
  sent: "Sent",
  simulated: "Simulated — not sent",
  review_required: "Review required — delivery unverified",
  delivered: "Delivered",
  failed: "Failed",
  pending: "Pending",
  read: "Read",
  skipped: "Skipped",
}

function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status.charAt(0).toUpperCase() + status.slice(1)
}

function channelIcon(channel: string) {
  switch (channel) {
    case "EMAIL":
      return <Mail className="w-4 h-4" />
    case "SMS":
      return <Phone className="w-4 h-4" />
    case "WHATSAPP":
      return <MessageSquare className="w-4 h-4" />
    default:
      return <Mail className="w-4 h-4" />
  }
}

function channelColor(channel: string): string {
  switch (channel) {
    case "EMAIL":
      return "#3B82F6"
    case "SMS":
      return "#8B5CF6"
    case "WHATSAPP":
      return "#25D366"
    default:
      return "#6B7280"
  }
}

function formatNotifDate(dateStr: string): string {
  const d = new Date(dateStr)
  return d.toLocaleDateString("en-ZA", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: SAST_TIME_ZONE,
  })
}

export function NotificationTabs({ items }: NotificationTabsProps) {
  const [activeChannel, setActiveChannel] = useState<string>("ALL")
  const [activeStatus, setActiveStatus] = useState<string>("ALL")

  const presentChannels = Array.from(new Set(items.map((i) => i.channel)))
    .filter((ch) => ch in CHANNEL_LABELS)
    .sort()
  const presentStatuses = Array.from(new Set(items.map((i) => i.status))).sort()

  const channelTabs = [
    { key: "ALL", label: "All" },
    ...presentChannels.map((ch) => ({ key: ch, label: CHANNEL_LABELS[ch] })),
  ]
  const statusTabs = [
    { key: "ALL", label: "All" },
    ...presentStatuses.map((s) => ({ key: s, label: statusLabel(s) })),
  ]

  // Channel and status are independent facets, combined with AND.
  const filtered = items.filter(
    (i) =>
      (activeChannel === "ALL" || i.channel === activeChannel) &&
      (activeStatus === "ALL" || i.status === activeStatus),
  )

  return (
    <>
      {/* Channel filter */}
      <div className="mb-3 flex gap-1 rounded-lg border border-[var(--cf-border-subtle)] bg-[var(--cf-bg-panel)] p-1">
        {channelTabs.map((tab) => {
          // Count reflects the other active facet (status) so badges match the list.
          const count = items.filter(
            (i) =>
              (tab.key === "ALL" || i.channel === tab.key) &&
              (activeStatus === "ALL" || i.status === activeStatus),
          ).length
          return (
            <button
              key={tab.key}
              onClick={() => setActiveChannel(tab.key)}
              className="flex-1 px-3 py-2 rounded-lg text-sm font-medium transition-colors"
              style={{
                backgroundColor:
                  activeChannel === tab.key ? "var(--cf-bg-subtle)" : "transparent",
                color:
                  activeChannel === tab.key ? "var(--cf-text)" : "var(--cf-text-muted)",
              }}
            >
              {tab.label}
              {count > 0 && (
                <span className="ml-1.5 text-xs opacity-60">
                  ({count})
                </span>
              )}
            </button>
          )
        })}
      </div>

      {/* Status filter — only shown when there is more than one status to choose from */}
      {presentStatuses.length > 1 && (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-widest text-[var(--cf-text-muted)]">
            Status
          </span>
          {statusTabs.map((tab) => {
            // Count reflects the other active facet (channel) so badges match the list.
            const count = items.filter(
              (i) =>
                (tab.key === "ALL" || i.status === tab.key) &&
                (activeChannel === "ALL" || i.channel === activeChannel),
            ).length
            const active = activeStatus === tab.key
            return (
              <button
                key={tab.key}
                onClick={() => setActiveStatus(tab.key)}
                className="px-3 py-1 rounded-full text-xs font-medium border transition-colors"
                style={{
                  backgroundColor: active ? "var(--cf-bg-subtle)" : "transparent",
                  color: active ? "var(--cf-text)" : "var(--cf-text-muted)",
                  borderColor: active ? "var(--cf-border-strong)" : "var(--cf-border-subtle)",
                }}
              >
                {tab.label}
                <span className="ml-1.5 opacity-60">({count})</span>
              </button>
            )
          })}
        </div>
      )}

      {/* List */}
      {filtered.length === 0 ? (
        <EmptyState
          icon={Bell}
          title="No notifications found"
          description="Payment reminders, document updates and application decisions will appear here once they are sent."
          action={{ label: "Back to Overview", href: "/portal" }}
        />
      ) : (
        <div className="divide-y divide-[var(--cf-border-subtle)] rounded-lg border border-[var(--cf-border-subtle)] bg-[var(--cf-bg-panel)]">
          {filtered.map((n) => (
            <div key={n.id} className="px-5 py-3.5 flex items-center gap-3">
              <div
                className="w-8 h-8 rounded-full flex items-center justify-center shrink-0"
                style={{
                  backgroundColor: channelColor(n.channel) + "15",
                  color: channelColor(n.channel),
                }}
              >
                {channelIcon(n.channel)}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-[var(--cf-text)] capitalize">
                  {n.eventLabel}
                </p>
                <p className="text-xs text-[var(--cf-text-muted)]">
                  {formatNotifDate(n.createdAt)}
                </p>
              </div>
              <div className="shrink-0 flex items-center gap-2">
                <span
                  className="px-2 py-0.5 rounded text-[10px] font-semibold uppercase"
                  style={{
                    backgroundColor: channelColor(n.channel) + "15",
                    color: channelColor(n.channel),
                  }}
                >
                  {n.channel}
                </span>
                <span
                  className="px-2 py-0.5 rounded text-[10px] font-semibold"
                  style={{
                    backgroundColor: n.status === "sent"
                      ? "#DCFCE7"
                      : n.status === "simulated" || n.status === "review_required"
                        ? "#FEF3C7"
                        : "#FEE2E2",
                    color: n.status === "sent"
                      ? "#166534"
                      : n.status === "simulated" || n.status === "review_required"
                        ? "#92400E"
                        : "#991B1B",
                  }}
                >
                  {statusLabel(n.status)}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  )
}
