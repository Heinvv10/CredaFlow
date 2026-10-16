"use client"

import { useState } from "react"
import { Camera, CheckCircle, Loader2, Send } from "lucide-react"
import { Button } from "@/components/ui/button"
import { DataPanel } from "@/components/app-shell/DataPanel"

type Channel = "SMS" | "WHATSAPP" | "EMAIL"

const CHANNELS = ["WHATSAPP", "SMS", "EMAIL"] as const

const CHANNEL_LABEL: Record<Channel, string> = {
  SMS: "SMS",
  WHATSAPP: "WhatsApp",
  EMAIL: "Email",
}

export interface SelfieLinkTokenView {
  channel: string
  /** Already masked server-side. The secret does not exist server-side to render. */
  sentTo: string
  expiresAt: string
  usedAt: string | null
}

/**
 * Staff surface for sending a consumer a one-time selfie capture link and
 * seeing what came back.
 *
 * There is deliberately no destination field: the route sends only to the
 * contact on the client record, because a staff-chosen destination would let
 * one account manufacture the consumer's KYC evidence. The copy says so, or
 * staff would go looking for the field that is missing.
 */
export function SelfieLinkSection({
  applicationId,
  latestToken,
  smsEnabled,
}: {
  applicationId: string
  latestToken: SelfieLinkTokenView | null
  /**
   * `isSmsChannelEnabled()` resolved on the server page — this is a client
   * component and cannot read the env var itself. When false the SMS button is
   * not rendered at all: the route refuses an SMS send, so offering the button
   * would be a control that fails 100% of the time.
   */
  smsEnabled: boolean
}) {
  const [sending, setSending] = useState<Channel | null>(null)
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)

  const sendLink = async (channel: Channel) => {
    setSending(channel)
    setResult(null)
    try {
      const res = await fetch(`/api/applications/${applicationId}/selfie/send-link`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel }),
      })
      const data = (await res.json().catch(() => null)) as
        | { sentTo?: string; simulated?: boolean; error?: string }
        | null
      setResult(
        res.ok
          ? {
              ok: true,
              message: data?.simulated
                ? `Simulated send to ${data?.sentTo ?? "the consumer"} (no provider configured)`
                : `Capture link sent to ${data?.sentTo ?? "the consumer"}`,
            }
          : { ok: false, message: data?.error ?? "The capture link could not be sent." },
      )
    } catch {
      setResult({ ok: false, message: "Network error — the link may not have been sent." })
    } finally {
      setSending(null)
    }
  }

  // A PORTAL link was opened by the signed-in client to continue on their
  // phone (POST /api/portal/selfie-link): nothing was sent anywhere.
  const status = !latestToken
    ? "No selfie link sent for this application yet."
    : latestToken.channel === "PORTAL"
      ? latestToken.usedAt
        ? `Photo received ${new Date(latestToken.usedAt).toLocaleString("en-ZA")} — from a link the client opened in the Client portal.`
        : `Waiting for the consumer — the client opened a link in the Client portal to continue on their phone, expires ${new Date(latestToken.expiresAt).toLocaleString("en-ZA")}.`
    : latestToken.usedAt
      ? `Photo received ${new Date(latestToken.usedAt).toLocaleString("en-ZA")} — sent by ${
          CHANNEL_LABEL[latestToken.channel as Channel] ?? latestToken.channel
        } to ${latestToken.sentTo}.`
      : `Waiting for the consumer — sent by ${
          CHANNEL_LABEL[latestToken.channel as Channel] ?? latestToken.channel
        } to ${latestToken.sentTo}, expires ${new Date(latestToken.expiresAt).toLocaleString("en-ZA")}.`

  return (
    <DataPanel title="Selfie capture link">
      <div className="space-y-3 text-sm text-[var(--cf-text-secondary)]">
        <p className="flex items-start gap-2">
          {latestToken?.usedAt
            ? <CheckCircle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--cf-success)]" />
            : <Camera className="mt-0.5 h-4 w-4 shrink-0" />}
          <span>{status}</span>
        </p>

        <p className="text-[var(--cf-text-muted)]">
          The link is only ever sent to the number or address already on file for this
          client. It is valid for 24 hours, can be used once, and sending again cancels
          the previous link.
        </p>

        <div className="flex flex-wrap gap-2">
          {CHANNELS.filter((channel) => channel !== "SMS" || smsEnabled).map((channel) => (
            <Button
              key={channel}
              type="button"
              variant="outline"
              size="sm"
              disabled={sending !== null}
              onClick={() => sendLink(channel)}
            >
              {sending === channel
                ? <Loader2 className="h-4 w-4 animate-spin" />
                : <Send className="h-4 w-4" />}
              {sending === channel
                ? "Sending..."
                : `Send link by ${CHANNEL_LABEL[channel]}`}
            </Button>
          ))}
        </div>

        {result && (
          <p
            role="status"
            className={
              result.ok
                ? "text-[var(--cf-success)]"
                : "text-[var(--cf-danger)]"
            }
          >
            {result.message}
          </p>
        )}
      </div>
    </DataPanel>
  )
}
