import { NextRequest, NextResponse } from "next/server"
import { Prisma } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { getDefaultTenantId } from "@/lib/tenant"
import { verifyCronSecret } from "@/lib/cron-auth"
import type { NotificationType } from "@/lib/notifications/bell"

/**
 * Escalation bands, in days before expiry. An adviser gets at most one alert
 * per band, so the whole window produces five alerts rather than one per run.
 *
 * Bands rather than an exact-day match: an exact match ("fire when
 * daysRemaining === 30") loses the alert entirely if that day's run is missed,
 * and this job is invoked by a scheduler that has been silent for its whole
 * life. A band fires on the first run at or inside it, whenever that happens.
 */
const ALERT_BANDS_DAYS = [60, 30, 14, 7, 1] as const

/** The tightest band `daysRemaining` has reached, or null if outside them all. */
export function alertBandFor(daysRemaining: number): number | null {
  const reached = ALERT_BANDS_DAYS.filter((band) => daysRemaining <= band)
  return reached.length > 0 ? Math.min(...reached) : null
}

const BUSINESS_TIMEZONE = "Africa/Johannesburg"

/** Days since the epoch for the calendar date `d` falls on in SAST. */
function sastDayIndex(d: Date): number {
  // en-CA formats as YYYY-MM-DD, which parses positionally without a locale
  // guess. Formatting in the business timezone is what makes this a calendar
  // question rather than a UTC-offset one.
  const [y, m, day] = new Intl.DateTimeFormat("en-CA", {
    timeZone: BUSINESS_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .format(d)
    .split("-")
    .map(Number)
  return Date.UTC(y, m - 1, day) / 86_400_000
}

/**
 * Whole calendar days from `from` to `expiry`, in SAST.
 *
 * NOT an elapsed-milliseconds floor. Licence expiry dates entered through the
 * settings form are stored at midnight, and this job runs at 05:15 — so on the
 * day before a licence expires, elapsed time is ~19 hours and floors to 0. The
 * alert would then tell an adviser their licence expires "in 0 day(s)" on the
 * day before it does, and write that same wrong number into the audit trail.
 * A compliance alert's text is a factual claim; counting calendar dates is
 * what makes it true.
 */
export function calendarDaysUntil(expiry: Date, from: Date): number {
  return sastDayIndex(expiry) - sastDayIndex(from)
}

/**
 * Midnight SAST on the calendar day `d` falls on.
 *
 * The query lower bound has to be this, not `now`. Licence dates come from an
 * `input[type=date]` and are stored at midnight, so a `gte: now` bound run at
 * 05:15 has already excluded every licence expiring TODAY — which makes the
 * 1-day band unreachable and silently removes the recovery path that bands
 * exist to provide (first deploy on the expiry date, or a missed run the day
 * before). South Africa observes no DST, so the fixed +02:00 offset is exact
 * rather than an approximation.
 */
export function startOfSastDay(d: Date): Date {
  const ymd = new Intl.DateTimeFormat("en-CA", {
    timeZone: BUSINESS_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d)
  return new Date(`${ymd}T00:00:00.000+02:00`)
}

export async function GET(req: NextRequest) {
  const denied = verifyCronSecret(req)
  if (denied) return denied

  try {
    const now = new Date()
    const in60Days = new Date(now)
    in60Days.setDate(in60Days.getDate() + 60)

    // FitAndProper records expiring between today (SAST) and 60 days out.
    // Already-expired licences are out of scope for a *warning*.
    const expiringRecords = await prisma.fitAndProper.findMany({
      where: {
        licenceExpiry: {
          gte: startOfSastDay(now),
          lte: in60Days,
        },
        // Active staff only. A deactivated account cannot sign in to read its
        // bell item, but alerting it would still burn the band's idempotency
        // marker — so if that adviser were reactivated inside the same band
        // and licence term, the marker would suppress the warning and they
        // would never be told. A deactivated adviser is also not practising,
        // so there is nothing to warn about until they are back.
        user: { active: true },
      },
      include: {
        user: {
          select: { id: true, name: true, email: true, tenantId: true },
        },
      },
    })

    const fallbackTenantId = await getDefaultTenantId()
    let processed = 0
    let alerted = 0
    let skippedAlreadyAlerted = 0
    let failed = 0

    for (const record of expiringRecords) {
      processed++
      const daysRemaining = calendarDaysUntil(new Date(record.licenceExpiry!), now)

      // IDEMPOTENCY. This handler is invoked by a daily schedule, so without a
      // durable marker one licence writes one NotificationLog and one AuditLog
      // row every single day of its 60-day window — ~60 duplicate "alerts" per
      // adviser into a regulated audit trail, and 60 apparently-pending
      // notifications. The AuditLog row IS the marker: an alert already written
      // for this record at this band means this run has nothing new to say.
      const band = alertBandFor(daysRemaining)
      if (band === null) continue

      // The marker is scoped to the LICENCE TERM, not just the record.
      // Renewing a licence updates the existing FitAndProper row rather than
      // replacing it, so a marker keyed on record id + band alone would let
      // the first term's alerts suppress every later term's — permanently,
      // and silently. The expiry date is what changes on renewal, so it is
      // what distinguishes one term's alerts from the next's.
      const termKey = new Date(record.licenceExpiry!).toISOString()

      try {
        // The marker check and the three writes are ONE serializable
        // transaction.
        //
        // Both properties matter. Atomicity: the audit row IS the idempotency
        // marker, so a marker committed beside a failed notification would
        // suppress this band forever and the adviser would never be told.
        // Isolation: read-then-write outside a transaction lets two
        // overlapping invocations — a hand-fired retry landing on the
        // scheduled run — both see no marker and both alert. AuditLog carries
        // no uniqueness constraint for this band/term key and adding one means
        // a unique index over two JSON fields on a shipped table, so the claim
        // is enforced by Serializable instead: Postgres detects the
        // read-write conflict and aborts the loser, which the catch below
        // turns into "retry on the next run".
        const wrote = await prisma.$transaction(
          async (tx) => {
            const alreadyAlerted = await tx.auditLog.findFirst({
              where: {
                action: "LICENCE_EXPIRY_ALERT",
                entity: "FitAndProper",
                entityId: record.id,
                AND: [
                  { newValue: { path: ["thresholdDays"], equals: band } },
                  { newValue: { path: ["licenceTerm"], equals: termKey } },
                ],
              },
              select: { id: true },
            })
            if (alreadyAlerted) return false

            await tx.auditLog.create({
            data: {
              tenantId: record.user.tenantId ?? fallbackTenantId,
              userId: record.userId,
              userEmail: record.user.email,
              action: "LICENCE_EXPIRY_ALERT",
              entity: "FitAndProper",
              entityId: record.id,
              newValue: {
                licenceNumber: record.licenceNumber,
                licenceExpiry: record.licenceExpiry,
                daysRemaining,
                // Both fields are load-bearing: together they are the marker
                // the next run reads.
                thresholdDays: band,
                licenceTerm: termKey,
                message: `Adviser licence for ${record.user.name ?? record.user.email} expires in ${daysRemaining} day(s). Renewal required.`,
              },
            },
            })

            // The bell item is the part a human actually sees. Without it this
            // job writes an audit row and a NotificationLog row that name no
            // recipient, reports `alerted`, and tells nobody their licence is
            // about to expire — which is the same silence the unscheduled job
            // produced, just more expensively.
            //
            // Built inline rather than through createNotification() in
            // lib/notifications/bell.ts because that helper takes its own
            // client and this one must be the transaction's `tx`.
            await tx.notification.create({
              data: {
                tenantId: record.user.tenantId ?? fallbackTenantId,
                userId: record.userId,
                type: "LICENCE_EXPIRY" satisfies NotificationType,
                title: `Adviser licence expires in ${daysRemaining} day(s)`,
                body: `Licence ${record.licenceNumber ?? "(no number on file)"} for ${record.user.name ?? record.user.email} expires on ${new Date(record.licenceExpiry!).toISOString().slice(0, 10)}. Renewal is required to stay Fit & Proper.`,
                entityType: "FitAndProper",
                entityId: record.id,
              },
            })

            await tx.notificationLog.create({
              data: {
                tenantId: record.user.tenantId ?? fallbackTenantId,
                event: "fit_and_proper_licence_expiry",
                channel: "system",
                status: "queued",
                clientId: null,
                loanId: null,
              },
            })

            return true
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        )

        if (wrote) alerted++
        else skippedAlreadyAlerted++
      } catch {
        // Non-fatal for the run: a serialization failure or a write error
        // rolls the marker back with the alert, so this adviser is simply
        // retried on the next run. Still counted, though — a compliance
        // alert that silently keeps failing to write is not "fine because
        // it'll retry tomorrow" if tomorrow keeps failing too, and a
        // hardcoded ok:true would hide that from the systemd wrapper, which
        // only fails the unit on HTTP >= 400 and never parses this body.
        failed++
      }
    }

    // `skipped` is the number of advisers already alerted at their current
    // band. On a healthy daily schedule it is the bulk of `processed`, and a
    // run where it is 0 while `alerted` equals `processed` means the
    // idempotency marker is not being found.
    const ok = failed === 0
    return NextResponse.json(
      { ok, processed, alerted, skipped: skippedAlreadyAlerted, failed },
      { status: ok ? 200 : 503 },
    )
  } catch (error) {
    console.error("Licence expiry cron failed:", error)
    return NextResponse.json({ error: "Cron job failed" }, { status: 500 })
  }
}
