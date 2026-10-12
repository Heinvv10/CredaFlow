import { describe, expect, it } from "vitest"
import { readShapes, withSymbolicDetectorShape } from "./onnx-shape"

// A miniature ONNX ModelProto, hand-encoded: protobuf varints and
// length-delimited fields, enough to carry a graph with one input, two
// outputs, a value_info hint and fields the patch must leave alone.
const varint = (n: number): number[] => {
  const out: number[] = []
  while (n > 0x7f) { out.push((n & 0x7f) | 0x80); n >>>= 7 }
  out.push(n)
  return out
}
const field = (number: number, bytes: number[]) => [...varint((number << 3) | 2), ...varint(bytes.length), ...bytes]
const text = (s: string) => [...Buffer.from(s, "utf8")]
const dimValue = (v: number) => field(1, [...varint(1 << 3), ...varint(v)])
const valueInfo = (name: string, dims: number[]) =>
  [...field(1, text(name)), ...field(2, field(1, [...varint(1 << 3), 1, ...field(2, dims.flatMap(dimValue))]))]

function model(): Buffer {
  const graph = [
    ...field(1, text("node-bytes-left-alone")), // stands in for the nodes
    ...field(11, valueInfo("input", [1, 3, 640, 640])),
    ...field(12, valueInfo("cls_8", [1, 6400, 1])),
    ...field(12, valueInfo("kps_32", [1, 400, 10])),
    ...field(13, valueInfo("hint", [1, 16, 320, 320])),
    ...field(5, text("initializer-bytes-left-alone")),
  ]
  return Buffer.from([...varint(1 << 3), 7, ...field(2, text("producer")), ...field(7, graph), ...field(8, text("opset"))])
}

describe("withSymbolicDetectorShape", () => {
  it("makes the input's height and width and each output's row count symbolic", () => {
    const before = readShapes(model())
    expect(before.inputs).toEqual([["input", [1, 3, 640, 640]]])
    const after = readShapes(withSymbolicDetectorShape(model()))
    expect(after.inputs).toEqual([["input", [1, 3, "h", "w"]]])
    expect(after.outputs).toEqual([["cls_8", [1, "rows", 1]], ["kps_32", [1, "rows", 10]]])
  })

  it("drops the value_info shape hints and keeps every other byte", () => {
    const patched = withSymbolicDetectorShape(model())
    expect(readShapes(patched).valueInfo).toEqual([])
    for (const kept of ["node-bytes-left-alone", "initializer-bytes-left-alone", "producer", "opset"]) {
      expect(patched.includes(Buffer.from(kept))).toBe(true)
    }
    expect(patched[0]).toBe(0x08) // the ir_version field still leads
  })

  it("is idempotent", () => {
    const once = withSymbolicDetectorShape(model())
    expect(withSymbolicDetectorShape(once).equals(once)).toBe(true)
  })

  it.each([
    ["no graph", Buffer.from([...varint(1 << 3), 7])],
    ["a truncated length", Buffer.from([...varint((7 << 3) | 2), 50, 1, 2])],
    ["no input named input", Buffer.from(field(7, field(11, valueInfo("other", [1, 3, 640, 640]))))],
  ])("refuses a model with %s", (_label, bytes) => {
    expect(() => withSymbolicDetectorShape(bytes)).toThrow()
  })
})
