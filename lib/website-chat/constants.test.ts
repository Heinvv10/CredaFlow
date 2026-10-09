import { describe, expect, it } from "vitest"
import { presenceEvent, presenceLine } from "./constants"

const B = "Acme Lending"

describe("presence lines", () => {
  it("writes the exact join and leave wording the visitor sees", () => {
    expect(presenceLine("Thandi", "joined", B)).toBe("Thandi from Acme Lending has joined the chat.")
    expect(presenceLine("A consultant", "left", B)).toBe("A consultant from Acme Lending has left the chat.")
  })

  it("recognises what the writer writes, so the two cannot drift", () => {
    expect(presenceEvent(presenceLine("Thandi", "joined", B), "Thandi", B)).toBe("joined")
    expect(presenceEvent(presenceLine("Thandi", "left", B), "Thandi", B)).toBe("left")
  })

  it("a staff line with no usable author is labelled Consultant by the poll and named A consultant by the writer: still recognised", () => {
    expect(presenceEvent(presenceLine("A consultant", "left", B), "Consultant", B)).toBe("left")
    expect(presenceEvent(presenceLine("A consultant", "joined", B), undefined, B)).toBe("joined")
    expect(presenceEvent(presenceLine("Consultant", "joined", B), "Consultant", B)).toBe("joined")
  })

  it("is a notice only for the author it names: another staff member typing the same words is just talking", () => {
    expect(presenceEvent(presenceLine("Thabo", "left", B), "Lerato", B)).toBeNull()
    expect(presenceEvent(presenceLine("Thabo", "joined", B), "Lerato", B)).toBeNull()
    expect(presenceEvent(presenceLine("Thabo", "left", B), undefined, B)).toBeNull()
    expect(presenceEvent(presenceLine("A consultant", "left", B), "Lerato", B)).toBeNull()
  })

  it.each([
    ["staff talking", "How can I help?"],
    ["more after the line", "Thandi from Acme Lending has joined the chat. How can I help?"],
    ["text before it on another line", "Hi\nThandi from Acme Lending has joined the chat."],
    ["no name", "from Acme Lending has joined the chat."],
    ["an empty name", " from Acme Lending has joined the chat."],
    ["no full stop", "Thandi from Acme Lending has left the chat"],
    ["another character for the full stop", "Thandi from Acme Lending has left the chatX"],
    ["another event", "Thandi from Acme Lending has paused the chat."],
    ["another organisation", "Thandi from Elsewhere has joined the chat."],
  ])("is not a presence line: %s", (_name, text) => {
    expect(presenceEvent(text, "Thandi", B)).toBeNull()
  })
})
