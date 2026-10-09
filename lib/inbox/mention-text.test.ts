import { describe, expect, it } from "vitest"
import {
  activeMentionQuery,
  filterMentionable,
  mentionLabel,
  MENTION_PICKER_MAX_ROWS,
  mentionsStillPresent,
  splitMentionHighlights,
} from "./mention-text"

// name: "" (not null) — `??` does not fall through, so before the trim guard the
// picker offered a blank row, insertion was a bare "@ ", and the stale filter
// then dropped it: a visible pick that tagged nobody. Every consumer of the
// label is exercised below against this same staffer, because they only work if
// they all produce the SAME string.
describe("mentionLabel", () => {
  const blank = { id: "u5", name: "", email: "eve@x.co" }

  it("falls through a blank display name to the email, like a null one", () => {
    expect(mentionLabel(blank)).toBe("eve@x.co")
    expect(mentionLabel({ name: "   ", email: "eve@x.co" })).toBe("eve@x.co")
    expect(mentionLabel({ name: null, email: "eve@x.co" })).toBe("eve@x.co")
  })

  it("leaves a real name untouched", () => {
    expect(mentionLabel({ name: "Bo Nkosi", email: "bo@x.co" })).toBe("Bo Nkosi")
  })

  // The picker's rows come from this filter, so a blank-named staffer is only
  // findable at all if the label it matches on is the email.
  it("offers the blank-named staffer under the email the picker will show", () => {
    expect(filterMentionable([blank], "eve")).toEqual([blank])
  })

  // …and the stale-mention filter has to match that same inserted string, or
  // the pick is dropped at submit and nobody is tagged.
  it("keeps the blank-named staffer's mention when the inserted label is present", () => {
    expect(mentionsStillPresent([blank], "@eve@x.co take a look")).toEqual([blank])
    expect(mentionsStillPresent([blank], "take a look")).toEqual([])
  })

  it("highlights the blank-named staffer's mention in the rendered note", () => {
    expect(splitMentionHighlights("@eve@x.co take a look", [mentionLabel(blank)])).toEqual([
      { text: "@eve@x.co", mention: true },
      { text: " take a look", mention: false },
    ])
  })
})

describe("activeMentionQuery", () => {
  it("returns the run between the last @ and the caret", () => {
    expect(activeMentionQuery("hello @cy", 9)).toEqual({ at: 6, query: "cy" })
  })

  it("returns an empty query for a bare @, so the full list opens", () => {
    expect(activeMentionQuery("hello @", 7)).toEqual({ at: 6, query: "" })
  })

  it("returns null when there is no @ before the caret", () => {
    expect(activeMentionQuery("no at sign here", 8)).toBeNull()
  })

  // The caret, not the end of the string: an agent who goes back to fix a
  // mention mid-sentence must not have the query derived from a later @.
  it("ignores an @ that sits after the caret", () => {
    expect(activeMentionQuery("hi @cy there", 2)).toBeNull()
  })

  it("uses the last @ before the caret, not the first", () => {
    expect(activeMentionQuery("@ab @cd", 7)).toEqual({ at: 4, query: "cd" })
    expect(activeMentionQuery("@ab @cd", 3)).toEqual({ at: 0, query: "ab" })
  })

  // Staff names are two words. One space has to stay inside the run or
  // "@Bo Nkosi" would stop matching the moment the surname started.
  it("keeps a single space inside the run", () => {
    expect(activeMentionQuery("@Bo Nkosi", 9)).toEqual({ at: 0, query: "Bo Nkosi" })
    expect(activeMentionQuery("@Bo ", 4)).toEqual({ at: 0, query: "Bo " })
  })

  it("closes the query once a second space is typed", () => {
    expect(activeMentionQuery("@Bo Nkosi please", 16)).toBeNull()
    expect(activeMentionQuery("@Bo  Nkosi", 10)).toBeNull()
  })

  it("closes the query on any whitespace that is not a plain space", () => {
    expect(activeMentionQuery("@Bo\nNkosi", 9)).toBeNull()
    expect(activeMentionQuery("@Bo\tNkosi", 9)).toBeNull()
  })

  // The `@` in an email address is not a mention trigger. Without the
  // word-start requirement this opens a run whose query is "x.co".
  it("ignores an @ that sits inside a word", () => {
    expect(activeMentionQuery("mail bo@x.co", 12)).toBeNull()
    expect(activeMentionQuery("bo@x.co", 7)).toBeNull()
  })

  it("still triggers on an @ at the start of the text or after whitespace", () => {
    expect(activeMentionQuery("@cy", 3)).toEqual({ at: 0, query: "cy" })
    expect(activeMentionQuery("mail us at @cy", 14)).toEqual({ at: 11, query: "cy" })
    expect(activeMentionQuery("line\n@cy", 8)).toEqual({ at: 5, query: "cy" })
  })

  // The rule targets an email local part, NOT "anything that isn't whitespace".
  // These are real mentions, and a picker that refuses to open here is the worse
  // failure: the staffer types the name by hand and ships a note that reads
  // tagged while draft.mentions is empty and nobody is notified.
  it("still triggers on an @ after punctuation", () => {
    expect(activeMentionQuery("(@Bo", 4)).toEqual({ at: 1, query: "Bo" })
    expect(activeMentionQuery("cc:@Bo", 6)).toEqual({ at: 3, query: "Bo" })
    expect(activeMentionQuery("hi,@Bo", 6)).toEqual({ at: 3, query: "Bo" })
  })

  it("clamps a caret outside the string instead of reading past it", () => {
    expect(activeMentionQuery("@cy", 99)).toEqual({ at: 0, query: "cy" })
    expect(activeMentionQuery("@cy", -1)).toBeNull()
  })
})

describe("mentionsStillPresent", () => {
  const bo = { id: "u2", name: "Bo Nkosi", email: "bo@x.co" }
  const cy = { id: "u3", name: "Cy Dlamini", email: "cy@x.co" }

  it("keeps a mention whose visible @name is still in the text", () => {
    expect(mentionsStillPresent([bo, cy], "@Bo Nkosi and @Cy Dlamini please chase")).toEqual([bo, cy])
  })

  // The whole point of the filter: picking @Cy Dlamini and then deleting the
  // text must not still ping her.
  it("drops a mention the agent deleted from the text before submitting", () => {
    expect(mentionsStillPresent([bo, cy], "@Bo Nkosi please chase")).toEqual([bo])
  })

  it("matches on the email for a staffer with no name, matching what was inserted", () => {
    const nameless = { id: "u4", name: null, email: "dee@x.co" }
    expect(mentionsStillPresent([nameless], "@dee@x.co take a look")).toEqual([nameless])
    expect(mentionsStillPresent([nameless], "take a look")).toEqual([])
  })

  it("requires the @ sigil, not just the bare name", () => {
    expect(mentionsStillPresent([bo], "Bo Nkosi already replied")).toEqual([])
  })

  // A blank display name now resolves to the email (see mentionLabel), so this
  // staffer is matched on "@eve@x.co" and is correctly absent from a note that
  // does not carry it.
  it("drops a mention whose display name is blank and whose email is not in the text", () => {
    const blank = { id: "u5", name: "", email: "eve@x.co" }
    expect(mentionsStillPresent([blank], "@Bo Nkosi please chase")).toEqual([])
    expect(mentionsStillPresent([blank, bo], "@Bo Nkosi please chase")).toEqual([bo])
  })

  // The last case where the label really is empty. Without the guard the check
  // degrades to text.includes("@"), which every note holding any mention run
  // satisfies — so the pick would survive the filter forever and deleting the
  // visible tag would never un-tag them.
  it("drops a mention with no name AND no email rather than matching a bare @", () => {
    const nothing = { id: "u6", name: "", email: "" }
    expect(mentionsStillPresent([nothing], "@Bo Nkosi please chase")).toEqual([])
  })
})

describe("filterMentionable", () => {
  const bo = { id: "u2", name: "Bo Nkosi", email: "bo@x.co" }
  const cy = { id: "u3", name: "Cy Dlamini", email: "cy@x.co" }
  const dee = { id: "u4", name: null, email: "dee@x.co" }

  it("matches the label case-insensitively on any substring", () => {
    expect(filterMentionable([bo, cy], "nko")).toEqual([bo])
    expect(filterMentionable([bo, cy], "DLA")).toEqual([cy])
  })

  it("matches a nameless staffer on the email it will insert", () => {
    expect(filterMentionable([bo, dee], "dee")).toEqual([dee])
  })

  // Finding 2: lib/inbox/notes.ts drops the author from the resolved list, so an
  // offered self-row inserts "@Me" and notifies nobody, with no feedback.
  it("excludes the note's own author", () => {
    expect(filterMentionable([bo, cy], "", "u2")).toEqual([cy])
    expect(filterMentionable([bo, cy], "bo", "u2")).toEqual([])
  })

  it("offers every row when no author is excluded", () => {
    expect(filterMentionable([bo, cy], "")).toEqual([bo, cy])
  })

  it("caps the rows so the list cannot outgrow the panel", () => {
    const roster = Array.from({ length: 12 }, (_, i) => ({ id: `u${i}`, name: `Staffer ${i}`, email: `s${i}@x.co` }))
    expect(filterMentionable(roster, "staffer")).toHaveLength(MENTION_PICKER_MAX_ROWS)
  })
})

describe("splitMentionHighlights", () => {
  it("splits the body into plain and mention segments", () => {
    expect(splitMentionHighlights("@Bo Nkosi please chase", ["Bo Nkosi"])).toEqual([
      { text: "@Bo Nkosi", mention: true },
      { text: " please chase", mention: false },
    ])
  })

  it("highlights every occurrence, not just the first", () => {
    expect(splitMentionHighlights("@Bo Nkosi and @Bo Nkosi", ["Bo Nkosi"])).toEqual([
      { text: "@Bo Nkosi", mention: true },
      { text: " and ", mention: false },
      { text: "@Bo Nkosi", mention: true },
    ])
  })

  // Shortest-first alternation would match "@Bo" inside "@Bo Nkosi" and leave
  // " Nkosi" as plain text, splitting one name across two segments.
  it("prefers the longest name when one is a prefix of another", () => {
    expect(splitMentionHighlights("@Bo Nkosi replied", ["Bo", "Bo Nkosi"])).toEqual([
      { text: "@Bo Nkosi", mention: true },
      { text: " replied", mention: false },
    ])
  })

  it("treats regex metacharacters in a name as literal text", () => {
    expect(splitMentionHighlights("@A.B done", ["A.B"])).toEqual([
      { text: "@A.B", mention: true },
      { text: " done", mention: false },
    ])
    // "A.B" as a live regex would also match "AxB"; as a literal it must not.
    expect(splitMentionHighlights("@AxB done", ["A.B"])).toEqual([
      { text: "@AxB done", mention: false },
    ])
  })

  it("returns the body untouched when nobody was mentioned", () => {
    expect(splitMentionHighlights("just a note", [])).toEqual([{ text: "just a note", mention: false }])
  })

  // These three fixtures each contain the exact text the guard's absence would
  // produce a label for, so removing the guard makes them fail. An earlier
  // version used a body with none of those, and passed either way.
  it("skips an empty display name rather than highlighting every bare @", () => {
    // Without the guard the label is a bare "@", which highlights every @ in
    // the note — the worst case, because it hits notes with no mentions at all.
    expect(splitMentionHighlights("chase @Bo now", [""])).toEqual([
      { text: "chase @Bo now", mention: false },
    ])
  })

  it("skips a whitespace-only display name", () => {
    expect(splitMentionHighlights("@  and @Bo", ["  "])).toEqual([
      { text: "@  and @Bo", mention: false },
    ])
  })

  it("skips a null display name", () => {
    expect(splitMentionHighlights("@null and @Bo", [null])).toEqual([
      { text: "@null and @Bo", mention: false },
    ])
  })

  // toThreadMessage nulls bodyText for a soft-deleted note precisely so the
  // text never ships in the page payload. Highlighting must not crash on that,
  // and must not invent a segment to render.
  it("returns no segments for a null or empty body", () => {
    expect(splitMentionHighlights(null, ["Bo Nkosi"])).toEqual([])
    expect(splitMentionHighlights("", ["Bo Nkosi"])).toEqual([])
  })
})
