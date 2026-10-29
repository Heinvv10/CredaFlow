/**
 * Source text with its comments removed (strings and template literals kept
 * verbatim), for tests that look for a call in code and must not be satisfied
 * by a comment that mentions it. A scanner, not a parser: a regex literal that
 * contains a quote can confuse it, which is acceptable for a test helper.
 */
export function stripComments(source: string): string {
  let out = ""
  let i = 0
  while (i < source.length) {
    const c = source[i]
    const next = source[i + 1]
    if (c === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i++
    } else if (c === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2)
      i = end === -1 ? source.length : end + 2
      out += " "
    } else if (c === '"' || c === "'" || c === "`") {
      let j = i + 1
      while (j < source.length && source[j] !== c) j += source[j] === "\\" ? 2 : 1
      out += source.slice(i, j + 1)
      i = j + 1
    } else {
      out += c
      i++
    }
  }
  return out
}
