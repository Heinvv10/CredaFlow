"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { LOCALES, LOCALE_NATIVE_NAMES, type Locale } from "@/lib/i18n/locales"
import type { LanguageReviews, ReviewableLocale } from "@/lib/i18n/language-reviews"

interface Props {
  enabled: Locale[]
  reviews: LanguageReviews
  /** Languages whose text was edited after their review: not served until re-acknowledged. */
  changedSinceReview: ReviewableLocale[]
  /** The viewer is a SUPER_ADMIN (the route enforces it again). */
  canChange: boolean
}

type Ack = { reviewer: string; confirmed: boolean }

/**
 * Borrower languages for this lender. af/zu/xh ship as machine drafts: turning
 * one on needs the name of the native speaker who reviewed it and an explicit
 * confirmation, recorded with who acknowledged it and when.
 */
export function LanguageSettingsCard({ enabled: initial, reviews, changedSinceReview, canChange }: Props) {
  const router = useRouter()
  const [enabled, setEnabled] = useState<Locale[]>(initial)
  const [acks, setAcks] = useState<Partial<Record<ReviewableLocale, Ack>>>({})
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ kind: "success" | "error"; text: string } | null>(null)

  const stale = (l: ReviewableLocale) => changedSinceReview.includes(l)
  const needsAck = (l: ReviewableLocale) => enabled.includes(l) && (!reviews[l] || stale(l))
  const toggle = (l: Locale, on: boolean) => setEnabled((cur) => (on ? [...cur, l] : cur.filter((x) => x !== l)))
  const setAck = (l: ReviewableLocale, patch: Partial<Ack>) =>
    setAcks((cur) => ({ ...cur, [l]: { reviewer: "", confirmed: false, ...cur[l], ...patch } }))

  async function save() {
    setSaving(true)
    setMessage(null)
    const acknowledgements = Object.fromEntries(
      (Object.entries(acks) as [ReviewableLocale, Ack][]).filter(([l]) => needsAck(l)),
    )
    try {
      const res = await fetch("/api/settings/languages", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabledLanguages: LOCALES.filter((l) => enabled.includes(l)), languageReviewAcknowledgements: acknowledgements }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok) {
        setMessage({ kind: "success", text: "Languages saved." })
        setAcks({})
        router.refresh()
      } else {
        setMessage({ kind: "error", text: data.error ?? "Failed to save the languages." })
      }
    } catch {
      setMessage({ kind: "error", text: "Failed to save the languages." })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Borrower languages</CardTitle>
        <CardDescription>
          Languages offered on the website, the client portal and borrower messages. Afrikaans, isiZulu and
          isiXhosa are machine drafts: switch one on only after a native speaker has reviewed it. Legal and NCA
          documents stay in English.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {LOCALES.map((l) => {
          const review = l === "en" ? undefined : reviews[l]
          return (
            <div key={l} className="space-y-2 rounded-md border border-[var(--cf-border-subtle)] p-3">
              <label className="flex items-center gap-3 text-sm font-medium">
                <input
                  type="checkbox"
                  checked={l === "en" || enabled.includes(l)}
                  disabled={l === "en" || !canChange || saving}
                  onChange={(e) => toggle(l, e.target.checked)}
                />
                {LOCALE_NATIVE_NAMES[l]}
                {l === "en" && <span className="text-xs text-muted-foreground">(always on)</span>}
              </label>
              {review && (
                <p className="text-xs text-muted-foreground">
                  Reviewed by {review.reviewer}; acknowledged by {review.acknowledgedByEmail ?? "unknown"} on {review.acknowledgedAt.slice(0, 10)}.
                </p>
              )}
              {l !== "en" && stale(l) && (
                <p className="text-xs font-medium text-[var(--cf-danger)]">
                  Changed since review: the {LOCALE_NATIVE_NAMES[l]} text was edited after this review, so it is not shown to
                  borrowers until a native speaker reviews it again and you acknowledge it.
                </p>
              )}
              {l !== "en" && needsAck(l) && (
                <div className="space-y-2 pl-6">
                  <Input
                    aria-label={`Native-speaker reviewer for ${LOCALE_NATIVE_NAMES[l]}`}
                    placeholder="Name of the native-speaker reviewer"
                    value={acks[l]?.reviewer ?? ""}
                    maxLength={120}
                    onChange={(e) => setAck(l, { reviewer: e.target.value })}
                  />
                  <label className="flex items-start gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={acks[l]?.confirmed ?? false}
                      onChange={(e) => setAck(l, { confirmed: e.target.checked })}
                    />
                    I confirm a native speaker reviewed the {LOCALE_NATIVE_NAMES[l]} text and it may be shown to borrowers.
                  </label>
                </div>
              )}
            </div>
          )
        })}
        <p className="text-sm text-muted-foreground">
          {canChange ? "Saving needs a session signed in with two-factor authentication where staff TOTP is required." : "Only a Super Admin can change this."}
        </p>
        <Button onClick={save} disabled={!canChange || saving}>{saving ? "Saving…" : "Save languages"}</Button>
        {message && (
          <p className={`text-sm ${message.kind === "success" ? "text-[var(--cf-success)]" : "text-[var(--cf-danger)]"}`}>{message.text}</p>
        )}
      </CardContent>
    </Card>
  )
}
