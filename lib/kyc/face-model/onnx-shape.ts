/**
 * The YuNet file declares a fixed 1x3x640x640 input, and onnxruntime refuses
 * any other size. Its graph does not depend on the size (every Reshape is to
 * [1, -1, k]); only the declared shapes do. This rewrites, in the verified
 * bytes, the input's height and width and each output's row count as
 * symbolic dimensions and drops the value_info shape hints, so one session
 * runs both the 640-fit pass and the ID-side full-resolution pass. Weights
 * and operators are untouched; at 640 the outputs are bit-identical to the
 * original file's (the golden test pins them).
 *
 * Just enough protobuf for ModelProto.graph (field 7): GraphProto input (11),
 * output (12), value_info (13); ValueInfoProto name (1), type (2);
 * TypeProto.tensor_type (1); Tensor.shape (2); TensorShapeProto.dim (1);
 * Dimension dim_value (1), dim_param (2). Everything else is copied byte for
 * byte.
 */
type Field = { number: number; wire: number; start: number; end: number; payloadStart: number }

function varint(bytes: Uint8Array, at: number): [number, number] {
  let value = 0
  for (let shift = 1, i = at; i < bytes.length; i++, shift *= 128) {
    value += (bytes[i] & 0x7f) * shift
    if (bytes[i] < 0x80) return [value, i + 1]
  }
  throw new Error("ONNX model: truncated varint")
}

function fields(bytes: Uint8Array): Field[] {
  const out: Field[] = []
  for (let at = 0; at < bytes.length;) {
    const [key, afterKey] = varint(bytes, at)
    const wire = key % 8
    let end: number
    let payloadStart = afterKey
    if (wire === 0) end = varint(bytes, afterKey)[1]
    else if (wire === 1) end = afterKey + 8
    else if (wire === 5) end = afterKey + 4
    else if (wire === 2) {
      const [length, afterLength] = varint(bytes, afterKey)
      payloadStart = afterLength
      end = afterLength + length
    } else throw new Error(`ONNX model: unsupported wire type ${wire}`)
    if (end > bytes.length) throw new Error("ONNX model: truncated field")
    out.push({ number: Math.floor(key / 8), wire, start: at, end, payloadStart })
    at = end
  }
  return out
}

const encodeVarint = (n: number): number[] => {
  const out: number[] = []
  for (; n >= 0x80; n = Math.floor(n / 128)) out.push((n % 128) | 0x80)
  out.push(n)
  return out
}
const lengthDelimited = (number: number, payload: Uint8Array) =>
  Buffer.concat([Buffer.from(encodeVarint(number * 8 + 2)), Buffer.from(encodeVarint(payload.length)), payload])
const payload = (bytes: Uint8Array, f: Field) => bytes.subarray(f.payloadStart, f.end)

/** Rebuilds `bytes`, replacing each length-delimited field `number` via `edit` (null drops it). */
function rewrite(bytes: Uint8Array, edits: Record<number, (inner: Uint8Array) => Uint8Array | null>): Buffer {
  return Buffer.concat(fields(bytes).map((f) => {
    const edit = f.wire === 2 ? edits[f.number] : undefined
    if (!edit) return bytes.subarray(f.start, f.end)
    const replaced = edit(payload(bytes, f))
    return replaced === null ? Buffer.alloc(0) : lengthDelimited(f.number, replaced)
  }))
}

/** A value_info with the dims at the given indexes renamed to symbolic parameters. */
const symbolic = (params: Record<number, string>) => (valueInfo: Uint8Array) =>
  rewrite(valueInfo, { 2: (type) => rewrite(type, { 1: (tensor) => rewrite(tensor, { 2: (shape) => {
    let index = 0
    return rewrite(shape, { 1: (dim) => {
      const param = params[index++]
      return param === undefined ? dim : lengthDelimited(2, Buffer.from(param, "utf8"))
    } })
  } }) }) })

const nameOf = (valueInfo: Uint8Array) => {
  const name = fields(valueInfo).find((f) => f.number === 1 && f.wire === 2)
  return name ? Buffer.from(payload(valueInfo, name)).toString("utf8") : ""
}

export function withSymbolicDetectorShape(model: Uint8Array): Buffer {
  const graphs = fields(model).filter((f) => f.number === 7 && f.wire === 2)
  if (graphs.length !== 1) throw new Error("ONNX model: expected one graph")
  let inputs = 0
  const patched = rewrite(model, { 7: (graph) => rewrite(graph, {
    11: (input) => (nameOf(input) === "input" ? (inputs++, symbolic({ 2: "h", 3: "w" })(input)) : input),
    12: symbolic({ 1: "rows" }),
    13: () => null,
  }) })
  if (inputs !== 1) throw new Error("ONNX model: expected one input named input")
  return patched
}

type Dim = number | string
type Shapes = { inputs: Array<[string, Dim[]]>; outputs: Array<[string, Dim[]]>; valueInfo: Array<[string, Dim[]]> }

/** The declared shapes, for tests and checks. */
export function readShapes(model: Uint8Array): Shapes {
  const shapes: Shapes = { inputs: [], outputs: [], valueInfo: [] }
  const graph = fields(model).find((f) => f.number === 7 && f.wire === 2)
  if (!graph) return shapes
  const g = payload(model, graph)
  const sub = (bytes: Uint8Array, number: number) => {
    const f = fields(bytes).find((x) => x.number === number && x.wire === 2)
    return f ? payload(bytes, f) : new Uint8Array()
  }
  for (const f of fields(g)) {
    const list = f.number === 11 ? shapes.inputs : f.number === 12 ? shapes.outputs : f.number === 13 ? shapes.valueInfo : null
    if (!list) continue
    const info = payload(g, f)
    const shape = sub(sub(sub(info, 2), 1), 2)
    const dims = fields(shape).filter((d) => d.number === 1).map((d): Dim => {
      const dim = payload(shape, d)
      const [value] = fields(dim).filter((x) => x.number === 1 || x.number === 2)
      return value.number === 1 ? varint(dim, value.payloadStart)[0] : Buffer.from(payload(dim, value)).toString("utf8")
    })
    list.push([nameOf(info), dims])
  }
  return shapes
}
