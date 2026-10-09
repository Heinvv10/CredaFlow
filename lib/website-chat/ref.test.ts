import { describe, expect, it } from "vitest"
import { newChatRef, parseChatRef } from "./ref"

describe("newChatRef", () => {
  it("matches the WC- format without ambiguous characters", () => {
    for (let i = 0; i < 200; i++) expect(newChatRef()).toMatch(/^WC-[A-HJ-NP-Z2-9]{6}$/)
  })
  it("draws from all 32 characters of the alphabet", () => {
    const seen = new Set<string>()
    for (let i = 0; i < 20_000; i++) for (const ch of newChatRef().slice(3)) seen.add(ch)
    expect([...seen].sort().join("")).toBe([..."ABCDEFGHJKLMNPQRSTUVWXYZ23456789"].sort().join(""))
  })
  it("is effectively unique", () => {
    const seen = new Set<string>()
    for (let i = 0; i < 1000; i++) seen.add(newChatRef())
    expect(seen.size).toBeGreaterThanOrEqual(990)
  })
})

describe("parseChatRef", () => {
  it("finds every ref newChatRef makes in the subject startChat writes", () => {
    for (let i = 0; i < 200; i++) {
      const ref = newChatRef()
      expect(parseChatRef(`Website chat ${ref}`)).toBe(ref)
    }
  })
  it("is null for no subject, a subject without a ref, and a ref with a character the alphabet leaves out", () => {
    for (const subject of [null, "", "Website chat", "Website chat WC-ABC12", "Website chat WC-ABCDE0", "Website chat WC-ABCDEI", "Website chat wc-abcdef"]) {
      expect(parseChatRef(subject)).toBeNull()
    }
  })
})
