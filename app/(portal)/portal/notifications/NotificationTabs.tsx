"use client"

import { useState } from "react"
import { Mail, MessageSquare, Phone, Bell } from "lucide-react"
import { EmptyState } from "@/components/app-shell/EmptyState"
import { useT } from "@/lib/i18n/client"
import type { MessageKey, Translator } from "@/lib/i18n/translate"
import type { BorrowerNotificationStatus } from "@/lib/portal/notification-status"

interface NotificationDisplay {
  id: string
  event: string
  eventLabel: string
  channel: string
  status: BorrowerNotificationStatus
  createdAt: string
  /** Server-formatted in the reader's language. */
  createdAtLabel: string
}

interface NotificationTabsProps {
  items: NotificationDisplay[]
}

type NotificationsT = Translator<"portalNotifications">

const CHANNEL_LABELS: Record<string, MessageKey<"portalNotifications">> = {
  SMS: "channelSms",
  EMAIL: "channelEmail",
  WHATSAPP: "channelWhatsapp",
}

// The borrower-facing status the page derived (lib/portal/notification-status.ts).
const STATUS_LABELS: Record<BorrowerNotificationStatus, MessageKey<"portalNotifications">> = {
  sent: "st_sent",
  not_delivered: "st_not_delivered",
  pending: "st_pending",
  simulated: "st_simulated",
}

const STATUS_COLOURS: Record<BorrowerNotificationStatus, { bg: string; fg: string }> = {
  sent: { bg: "#DCFCE7", fg: "#166534" },
  not_delivered: { bg: "#FEF3C7", fg: "#92400E" },
  pending: { bg: "#F3F4F6", fg: "#374151" },
  simulated: { bg: "#FEF3C7", fg: "#92400E" },
}

function statusLabel(t: NotificationsT, status: BorrowerNotificationStatus): string {
  return t(STATUS_LABELS[status])
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

export function NotificationTabs({ items }: NotificationTabsProps) {
  const [activeChannel, setActiveChannel] = useState<string>("ALL")
  const [activeStatus, setActiveStatus] = useState<string>("ALL")
  const t = useT("portalNotifications")

  const presentChannels = Array.from(new Set(items.map((i) => i.channel)))
    .filter((ch) => ch in CHANNEL_LABELS)
    .sort()
  const presentStatuses = Array.from(new Set(items.map((i) => i.status))).sort()

  const channelTabs = [
    { key: "ALL", label: t("all") },
    ...presentChannels.map((ch) => ({ key: ch, label: t(CHANNEL_LABELS[ch]) })),
  ]
  const statusTabs = [
    { key: "ALL", label: t("all") },
    ...presentStatuses.map((s) => ({ key: s, label: statusLabel(t, s) })),
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
            {t("status")}
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
          title={t("emptyTitle")}
          description={t("emptyDesc")}
          action={{ label: t("backToOverview"), href: "/portal" }}
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
                  {n.createdAtLabel}
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
                    backgroundColor: STATUS_COLOURS[n.status].bg,
                    color: STATUS_COLOURS[n.status].fg,
                  }}
                >
                  {statusLabel(t, n.status)}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  )
}
