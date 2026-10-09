import { describe, it, expect } from "vitest"
import {
  duplicateNoticeChannelKey,
  throttleWindowStart,
  selectNoticeRecipients,
  buildDuplicateNotice,
  DUPLICATE_NOTICE_WINDOW_MS,
} from "@/lib/crm/lead-duplicate-notice"

const prior = (over: Partial<Parameters<typeof selectNoticeRecipients>[0][0]> & { id: string }) => ({
  firstName: "Nhlanhla",
  lastName: "Mocktest",
  status: "CONTACTED",
  assignedToId: "user_1",
  ...over,
})

describe("duplicateNoticeChannelKey", () => {
  it("keys on the PRIOR lead, so one prior lead cannot be announced twice a window", () => {
    expect(duplicateNoticeChannelKey("lead_abc")).toBe("lead-duplicate:lead_abc")
  })

  it("gives different keys to different prior leads", () => {
    expect(duplicateNoticeChannelKey("a")).not.toBe(duplicateNoticeChannelKey("b"))
  })
})

describe("throttleWindowStart", () => {
  it("floors to a fixed bucket so the claim is one atomic unique insert", () => {
    // A sliding window cannot be expressed as a unique constraint; the fixed
    // bucket is what makes the insert-and-catch race-free.
    const t = Date.parse("2026-08-15T09:41:00.000Z")
    expect(throttleWindowStart(t).toISOString()).toBe("2026-08-15T06:00:00.000Z")
  })

  it("puts two times in the same bucket on the same window start", () => {
    const a = throttleWindowStart(Date.parse("2026-08-15T06:00:00.000Z"))
    const b = throttleWindowStart(Date.parse("2026-08-15T11:59:59.999Z"))
    expect(a.getTime()).toBe(b.getTime())
  })

  it("rolls to the next bucket at the boundary", () => {
    const a = throttleWindowStart(Date.parse("2026-08-15T11:59:59.999Z"))
    const b = throttleWindowStart(Date.parse("2026-08-15T12:00:00.000Z"))
    expect(b.getTime() - a.getTime()).toBe(DUPLICATE_NOTICE_WINDOW_MS)
  })
})

describe("selectNoticeRecipients", () => {
  it("returns the assigned agent of each prior lead", () => {
    expect(selectNoticeRecipients([prior({ id: "a", assignedToId: "user_1" })]))
      .toEqual([{ userId: "user_1", leadIds: ["a"] }])
  })

  it("notifies NOBODY for an unassigned prior lead", () => {
    // An unowned lead has no queue to land in. Inventing a broadcast recipient
    // is the classic notification everyone assumes someone else handled; the
    // board badge and work queue already surface these.
    expect(selectNoticeRecipients([prior({ id: "a", assignedToId: null })])).toEqual([])
  })

  it("sends ONE notice per agent when they own several matching leads", () => {
    const out = selectNoticeRecipients([
      prior({ id: "a", assignedToId: "user_1" }),
      prior({ id: "b", assignedToId: "user_1" }),
    ])
    expect(out).toEqual([{ userId: "user_1", leadIds: ["a", "b"] }])
  })

  it("sends to each distinct agent when the duplicates are owned by different people", () => {
    const out = selectNoticeRecipients([
      prior({ id: "a", assignedToId: "user_1" }),
      prior({ id: "b", assignedToId: "user_2" }),
    ])
    expect(out.map((r) => r.userId).sort()).toEqual(["user_1", "user_2"])
  })

  it("drops the unassigned ones but keeps the assigned ones in a mixed set", () => {
    const out = selectNoticeRecipients([
      prior({ id: "a", assignedToId: null }),
      prior({ id: "b", assignedToId: "user_1" }),
    ])
    expect(out).toEqual([{ userId: "user_1", leadIds: ["b"] }])
  })

  it("handles an empty match set", () => {
    expect(selectNoticeRecipients([])).toEqual([])
  })
})

describe("buildDuplicateNotice", () => {
  const facts = { applicantName: "Nhlanhla Mocktest", priorLeadCount: 1, priorStatus: "CONTACTED" }

  it("names the person and says what happened", () => {
    const n = buildDuplicateNotice(facts)
    expect(n.title).toContain("Nhlanhla Mocktest")
    expect(n.body).toMatch(/enquiry/i)
  })

  it("never claims the person APPLIED", () => {
    // The same notice fires for the contact form and the insurance enquiry.
    // "Applied" would tell the agent this person submitted a loan application
    // when they filled in a contact form — a false claim about a consumer's
    // action, on a regulated lender's staff surface.
    const n = buildDuplicateNotice(facts)
    expect(`${n.title} ${n.body} ${n.html}`).not.toMatch(/\bapplied\b/i)
  })

  it("carries NO contact details", () => {
    // The agent opens the lead to see phone/email. Putting them in a bell item
    // and an email widens where this person's contact details live for no gain.
    const n = buildDuplicateNotice({ ...facts, applicantName: "Nhlanhla Mocktest" })
    const all = `${n.title} ${n.body}`
    expect(all).not.toMatch(/@/)
    expect(all).not.toMatch(/\d{9}/)
  })

  it("escapes a name containing HTML so it cannot inject into the email", () => {
    const n = buildDuplicateNotice({ ...facts, applicantName: '<img src=x onerror="alert(1)">' })
    expect(n.html).not.toContain("<img")
    expect(n.html).toContain("&lt;img")
  })

  it("states the match BASIS rather than asserting identity", () => {
    // The matcher cannot separate a returning applicant from a relative on the
    // same handset with the same name. Telling an agent "this is the same
    // person" would be a false claim about a consumer.
    const n = buildDuplicateNotice(facts)
    // Says WHAT was compared, and frames identity as something for the agent to
    // confirm. Copy that asserted identity outright would lose "check whether".
    expect(n.body).toMatch(/by phone number and name/i)
    expect(n.body).toMatch(/check whether/i)
    expect(n.html).toMatch(/check whether/i)
  })

  it("pluralises on the number of prior leads", () => {
    expect(buildDuplicateNotice({ ...facts, priorLeadCount: 1 }).body).toMatch(/1 open lead\b/)
    expect(buildDuplicateNotice({ ...facts, priorLeadCount: 3 }).body).toMatch(/3 open leads\b/)
  })
})
