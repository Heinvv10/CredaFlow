import type { ReactTestRenderer, ReactTestRendererNode } from "react-test-renderer"

/** The text a rendered tree shows, without markup, for assertions in the lease panel tests. */
export function renderedText(renderer: ReactTestRenderer): string {
  const flatten = (node: ReactTestRendererNode | ReactTestRendererNode[] | null): string => {
    if (node === null) return ""
    if (typeof node === "string") return node
    if (Array.isArray(node)) return node.map(flatten).join("")
    return (node.children ?? []).map(flatten).join("")
  }
  return flatten(renderer.toJSON())
}
