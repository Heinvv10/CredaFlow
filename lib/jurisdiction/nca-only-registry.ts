/**
 * The census of NCA-only surfaces (routes and pages), declared one file per
 * domain under lib/registry/nca-only/ and checked by nca-only-census.test.ts
 * (structure, comments ignored) and nca-only-behaviour.test.ts (each one is
 * actually refused under an LS lender).
 *
 * Every entry says how a lender outside the NCA's jurisdiction is kept out:
 * - `direct`: the file itself awaits `ncaOnlyRefusal()` / `ncaOnlyPage()` /
 *   `ncaOnlyCronSkip()`.
 * - `branches`: a route serving many types; each named `type === "..."` branch
 *   awaits `ncaOnlyRefusal()` inside itself.
 * - `via`: the file is gated by something it calls, named by `proof`: each
 *   `{ file, contains }` pair must hold in code (not in a comment).
 */
export type NcaOnlyGate =
  | { gate: "direct" }
  | { gate: "branches"; types: readonly string[] }
  | { gate: "via"; reason: string; proof: readonly { file: string; contains: string }[] }

export type NcaOnlySurfaces = Readonly<Record<string, NcaOnlyGate>>

export function defineNcaOnlySurfaces<T extends NcaOnlySurfaces>(surfaces: T): T {
  return surfaces
}
