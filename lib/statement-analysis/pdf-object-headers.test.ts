import { describe, expect, it } from "vitest"
import { objectHeaders } from "./pdf-object-headers"

const headers = (text: string, end = text.length) => Object.fromEntries(objectHeaders(Buffer.from(text, "latin1"), end))

describe("objectHeaders", () => {
  it("finds each header at its object number's first byte", () => {
    expect(headers("%PDF-1.7\n1 0 obj\n<< >>\nendobj\n11 0 obj\n<< >>\nendobj\n11 0 obj")).toEqual({ 1: [9], 11: [30, 52] })
  })

  it("starts a header after a delimiter as well as after whitespace", () => {
    expect(headers("<</A 1>>5 0 obj")).toEqual({ 5: [8] })
    expect(headers("[1 2]6 0 obj")).toEqual({ 6: [5] })
  })

  it("reads a comment as whitespace between a header's tokens", () => {
    expect(headers("7 % one\n0 % two\robj")).toEqual({ 7: [0] })
  })

  it("does not take a token that merely contains the parts for a header", () => {
    expect(headers("/x5 0 obj 5 0 objx 5 x 0 obj 99999999999 0 obj")).toEqual({})
    expect(headers("1 % 0 obj")).toEqual({})
  })

  it("takes the last two integers before obj", () => {
    expect(headers("12 5 0 obj")).toEqual({ 5: [3] })
  })

  it("reads only up to the end it is given", () => {
    expect(headers("1 0 obj 2 0 obj", 8)).toEqual({ 1: [0] })
  })
})
