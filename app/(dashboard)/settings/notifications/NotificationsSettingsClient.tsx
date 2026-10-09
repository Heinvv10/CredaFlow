"use client"

import { useMemo, useState } from "react"
import type { Channel } from "@prisma/client"
import { Bell, MessageSquare, Mail, CheckCircle, XCircle, Info } from "lucide-react"
import { SAST_TIME_ZONE } from "@/lib/utils"
import { notificationLogDisplayStatus } from "@/lib/integrations/simulation-presentation"
import { WabaTemplateEditor, type WabaTemplate } from "./WabaTemplateEditor"

/**
 * Channels this tab shows, in the `Channel` enum casing Prisma stores. Typed
 * rather than `string[]`: the column became the uppercase enum, and the
 * lowercase literals left behind silently missed EVERY channel-keyed lookup —
 * the template map and the per-channel labels — so a real template rendered as
 * "Default" over built-in copy the system never sends. A wrong casing is now a
 * compile error, not a silent miss.
 */
export type EditableChannel = Extract<Channel, "SMS" | "EMAIL">

interface EventDef {
  event: string
  label: string
  channels: EditableChannel[]
}

interface Template {
  id: string
  event: string
  channel: EditableChannel
  /** Non-null marks a SYSTEM template: seeded by migration and resolved at
   * dispatch time by this key. Nothing here may write it. */
  key: string | null
  subject: string | null
  body: string
  active: boolean
  createdAt: string
  updatedAt: string
}

interface NotifLog {
  id: string
  loanId: string | null
  clientId: string | null
  event: string
  channel: string
  status: string
  error: string | null
  createdAt: string
}

interface Props {
  defaultEvents: EventDef[]
  templates: Template[]
  recentLogs: NotifLog[]
  wabaTemplates: WabaTemplate[]
  /** ADMIN floor, resolved server-side to match the WABA route's own guard. */
  canEditWaba: boolean
}

export function NotificationsSettingsClient({ defaultEvents, templates, recentLogs, wabaTemplates, canEditWaba }: Props) {
  const templateMap = useMemo(() => {
    const m: Record<string, Template> = {}
    for (const t of templates) {
      m[`${t.event}::${t.channel}`] = t
    }
    return m
  }, [templates])
  const [activeTab, setActiveTab] = useState<"templates" | "waba" | "logs">("templates")

  const getTemplate = (event: string, channel: EditableChannel) => templateMap[`${event}::${channel}`]

  return (
    <div>
      {/* Tabs */}
      <div className="bg-white border-b border-[#e2e5ea]">
        <div className="px-6 flex gap-6">
          {[
            { key: "templates", label: "SMS & Email Templates" },
            ...(canEditWaba ? [{ key: "waba", label: `WhatsApp Templates (${wabaTemplates.length})` }] : []),
            { key: "logs", label: `Notification Log (${recentLogs.length})` },
          ].map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key as "templates" | "waba" | "logs")}
              className={`py-3.5 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab.key
                  ? "border-[#4F46E5] text-[#4F46E5]"
                  : "border-transparent text-gray-500 hover:text-gray-700"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      <div className="p-6">
        {activeTab === "templates" && (
          <div className="space-y-6">
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 flex items-start gap-2.5">
              <Info className="h-4 w-4 text-blue-600 shrink-0 mt-0.5" />
              <div className="text-sm text-blue-900 space-y-1">
                <p className="font-medium">This screen is read-only.</p>
                <p className="text-xs text-blue-800">
                  Every row here is created by a migration, and dispatch finds it by a{" "}
                  <code className="font-mono">key</code> this screen cannot set. Where the customer&rsquo;s wording
                  actually lives differs by row, so check the body below before assuming.
                </p>
                <ul className="text-xs text-blue-800 list-disc pl-4 space-y-0.5">
                  <li>
                    A body that is a placeholder like <code className="font-mono">{"{{body}}"}</code> is only an
                    envelope — that wording is composed in code, in{" "}
                    <code className="font-mono">buildTemplate()</code> (<code className="font-mono">lib/notifications.ts</code>).
                  </li>
                  <li>
                    The Section 129 row is the exception: its body IS the statutory letter sent to the customer. That
                    text is NCA-mandated, lives with the notice in <code className="font-mono">lib/pdf/</code>, and needs
                    legal sign-off to change.
                  </li>
                </ul>
                <p className="text-xs text-blue-800">Change any of them with a migration.</p>
              </div>
            </div>

            {/* Event rows */}
            {defaultEvents.map((ev) => (
              <div key={ev.event} className="bg-white rounded-lg border border-[#e5e7eb] overflow-hidden">
                <div className="px-5 py-3.5 bg-[#f9fafb] border-b border-[#e5e7eb] flex items-center gap-2">
                  <Bell className="h-4 w-4 text-[#4F46E5]" />
                  <span className="font-semibold text-[#1b1d24]">{ev.label}</span>
                  <code className="text-xs text-gray-400 ml-2">{ev.event}</code>
                </div>
                <div className="divide-y divide-[#e5e7eb]">
                  {ev.channels.map((channel) => {
                    const tpl = getTemplate(ev.event, channel)

                    return (
                      <div key={channel} className="px-5 py-4">
                        <div className="flex items-center justify-between mb-3">
                          <div className="flex items-center gap-2">
                            {channel === "SMS" ? (
                              <MessageSquare className="h-4 w-4 text-blue-500" />
                            ) : (
                              <Mail className="h-4 w-4 text-purple-500" />
                            )}
                            <span className="text-sm font-medium capitalize text-gray-700">{channel === "SMS" ? "SMS" : "Email"}</span>
                            {tpl?.key ? (
                              <span className="text-[10px] px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 font-medium">
                                System · {tpl.key}
                              </span>
                            ) : tpl ? (
                              // A row with no key is unreachable: the dispatcher
                              // resolves only by key. Saying "Custom" would imply
                              // it is in use.
                              <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 font-medium">
                                Unused · no dispatch key
                              </span>
                            ) : (
                              <span className="text-[10px] px-2 py-0.5 rounded-full bg-gray-100 text-gray-500 font-medium">No row</span>
                            )}
                          </div>
                        </div>

                        {/* Deliberately makes NO claim about whether the event
                            sends. It may: with the per-event new-send flag off,
                            lib/notifications.ts sends from buildTemplate() and
                            consults no row at all. */}
                        <p className="text-xs text-gray-500 font-mono bg-gray-50 rounded p-3 whitespace-pre-wrap line-clamp-4">
                          {tpl?.body ?? "No stored template row for this event and channel."}
                        </p>
                      </div>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        )}

        {activeTab === "waba" && canEditWaba && <WabaTemplateEditor templates={wabaTemplates} />}

        {activeTab === "logs" && (
          <div className="bg-white rounded-lg border border-[#e5e7eb] overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-[#f9fafb] border-b border-[#e5e7eb]">
                <tr>
                  <th className="text-left px-4 py-3 text-[11px] font-semibold uppercase tracking-wider text-gray-500">Event</th>
                  <th className="text-left px-4 py-3 text-[11px] font-semibold uppercase tracking-wider text-gray-500">Channel</th>
                  <th className="text-left px-4 py-3 text-[11px] font-semibold uppercase tracking-wider text-gray-500">Status</th>
                  <th className="text-left px-4 py-3 text-[11px] font-semibold uppercase tracking-wider text-gray-500">Logged At</th>
                  <th className="text-left px-4 py-3 text-[11px] font-semibold uppercase tracking-wider text-gray-500">Error</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#eceef2]">
                {recentLogs.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-8 text-center text-gray-400 text-sm">No notifications logged yet</td>
                  </tr>
                ) : (
                  recentLogs.map((log) => {
                    const displayStatus = notificationLogDisplayStatus(log.status)
                    return <tr key={log.id} className="hover:bg-[#f9fafb]">
                      <td className="px-4 py-3 font-mono text-xs text-gray-700">{log.event}</td>
                      <td className="px-4 py-3">
                        <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${
                          log.channel === "sms" ? "bg-blue-100 text-blue-700" : "bg-purple-100 text-purple-700"
                        }`}>{log.channel.toUpperCase()}</span>
                      </td>
                      <td className="px-4 py-3">
                        {displayStatus.tone === "success" ? (
                          <span className="flex items-center gap-1 text-green-700 text-xs"><CheckCircle className="h-3.5 w-3.5" />{displayStatus.label}</span>
                        ) : displayStatus.tone === "simulation" ? (
                          <span className="flex items-center gap-1 text-amber-700 text-xs"><MessageSquare className="h-3.5 w-3.5" />{displayStatus.label}</span>
                        ) : (
                          <span className="flex items-center gap-1 text-red-600 text-xs"><XCircle className="h-3.5 w-3.5" />{displayStatus.label}</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-500">
                        {new Date(log.createdAt).toLocaleString("en-ZA", { timeZone: SAST_TIME_ZONE })}
                      </td>
                      <td className="px-4 py-3 text-xs text-red-500 max-w-[200px] truncate">
                        {log.error ?? "—"}
                      </td>
                    </tr>
                  })
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
