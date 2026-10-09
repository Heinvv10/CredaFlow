"use client"

import type { MentionableStaff } from "@/components/comms/MentionPicker"

/**
 * The mentionable-staff roster, fetched lazily and shared by every surface that
 * can open a mention picker.
 *
 * The cache is MODULE-level, not per component instance. A thread renders one
 * composer plus one MessageBubble per note, so an instance-level cache would
 * let a staffer editing notes in a busy thread fire one identical roster
 * request per bubble. This way a page load costs at most one request.
 *
 * The in-flight promise is cached, not just its result: several callers (a fast
 * typist, two bubbles opening a query in the same tick) must share ONE request,
 * and a caller that unmounts mid-flight must not leave the list permanently
 * unset — the next caller awaits this same promise and gets the answer.
 */
let inFlight: Promise<MentionableStaff[]> | null = null

/**
 * Never rejects: losing the roster costs the autocomplete, not the note, since
 * the agent can still type "@Bo Nkosi" by hand and submit.
 */
export function loadMentionableStaff(): Promise<MentionableStaff[]> {
  inFlight ??= (async () => {
    try {
      const res = await fetch("/api/staff/mentionable")
      // `res.ok` on an undefined response throws in here too, which is the
      // point: every degraded shape lands in the one catch.
      if (!res.ok) throw new Error(`mentionable lookup failed: ${res.status}`)
      const list: unknown = await res.json()
      return Array.isArray(list) ? (list as MentionableStaff[]) : []
    } catch {
      // Dropped so a later `@` retries a transient outage rather than leaving
      // every mention surface without autocomplete for the rest of the session.
      inFlight = null
      return []
    }
  })()
  return inFlight
}

/**
 * Drops the cache. Module state outlives a single test in vitest (isolation is
 * per FILE), so a suite that asserts on request counts has to start from cold.
 * Nothing in the app calls this.
 */
export function resetMentionableStaffCache(): void {
  inFlight = null
}
