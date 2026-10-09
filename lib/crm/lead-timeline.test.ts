import { it, expect } from "vitest"
import { mergeLeadTimeline, type TimelineActivityInput, type TimelineMessageInput } from "./lead-timeline"

function activity(over: Partial<TimelineActivityInput> = {}): TimelineActivityInput {
  return {
    id: "a1",
    type: "CALL",
    subject: "Called lead",
    notes: null,
    createdAt: new Date("2026-07-01T10:00:00Z"),
    ...over,
  }
}

function message(over: Partial<TimelineMessageInput> = {}): TimelineMessageInput {
  return {
    id: "m1",
    conversationId: "cv1",
    channel: "WHATSAPP",
    direction: "OUTBOUND",
    isInternal: false,
    bodyText: "Hi there",
    status: "DELIVERED",
    hasMedia: false,
    createdByName: "Agent Smith",
    createdAt: "2026-07-02T10:00:00Z",
    ...over,
  }
}

it("returns activities and messages merged, newest first", () => {
  const entries = mergeLeadTimeline(
    [activity({ id: "a1", createdAt: new Date("2026-07-01T10:00:00Z") })],
    [
      message({ id: "m1", createdAt: "2026-07-02T10:00:00Z" }),
      message({ id: "m2", createdAt: "2026-06-30T10:00:00Z" }),
    ],
  )
  expect(entries.map((e) => e.id)).toEqual(["m1", "a1", "m2"])
})

it("maps activity fields onto a kind:'activity' entry", () => {
  const [entry] = mergeLeadTimeline([activity({ notes: "left voicemail" })], [])
  expect(entry).toEqual({
    kind: "activity",
    id: "a1",
    type: "CALL",
    subject: "Called lead",
    notes: "left voicemail",
    createdAt: new Date("2026-07-01T10:00:00Z"),
  })
})

it("maps message fields onto a kind:'message' entry with a Date createdAt", () => {
  const [entry] = mergeLeadTimeline([], [message()])
  expect(entry).toEqual({
    kind: "message",
    id: "m1",
    conversationId: "cv1",
    channel: "WHATSAPP",
    direction: "OUTBOUND",
    bodyText: "Hi there",
    status: "DELIVERED",
    hasMedia: false,
    createdByName: "Agent Smith",
    createdAt: new Date("2026-07-02T10:00:00Z"),
  })
})

it("excludes internal inbox notes from the lead timeline", () => {
  const entries = mergeLeadTimeline([], [
    message({ id: "m1", isInternal: true }),
    message({ id: "m2", isInternal: false }),
  ])
  expect(entries.map((e) => e.id)).toEqual(["m2"])
})

it("returns [] for empty inputs", () => {
  expect(mergeLeadTimeline([], [])).toEqual([])
})
