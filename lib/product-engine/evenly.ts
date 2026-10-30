/** `total` split evenly over `parts`, the remainder on the last. Shared by the generator and by what reads its deferred shares back. */
export function evenly(total: number, parts: number): number[] {
  const share = Math.floor(total / parts)
  return Array.from({ length: parts }, (_, i) => (i === parts - 1 ? total - share * (parts - 1) : share))
}
