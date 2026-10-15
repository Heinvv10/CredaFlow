// The starts of the Unicode decimal-digit blocks (ten digits each, 0 to 9) the buyer screening reads as ASCII digits,
// beyond ASCII itself. ONE list for the TypeScript screening (recovery-screening.ts fold) and the SQL
// recoveryAsciiDigits (migration 20261015400000, generated from this list): a digit one side knows and the other
// does not is a way past the comparison, so neither uses the runtime's own Unicode tables. Every \p{Nd} block of Unicode
// 17 (Node 25) is here; recovery-screening-digits.test.ts fails if this runtime knows a digit that is not, so a newer
// Unicode asks for a new row here and in the migration's list.
export const DIGIT_BLOCK_STARTS: readonly number[] = [
  1632, 1776, 1984, 2406, 2534, 2662, 2790, 2918,
  3046, 3174, 3302, 3430, 3558, 3664, 3792, 3872,
  4160, 4240, 6112, 6160, 6470, 6608, 6784, 6800,
  6992, 7088, 7232, 7248, 42528, 43216, 43264, 43472,
  43504, 43600, 44016, 65296, 66720, 68912, 68928, 69734,
  69872, 69942, 70096, 70384, 70736, 70864, 71248, 71360,
  71376, 71386, 71472, 71904, 72016, 72688, 72784, 73040,
  73120, 73184, 73552, 90416, 92768, 92864, 93008, 93552,
  118000, 120782, 120792, 120802, 120812, 120822, 123200, 123632,
  124144, 124401, 125264, 130032,
]

const ZERO_OF = new Map<number, number>()
for (const start of DIGIT_BLOCK_STARTS) for (let digit = 0; digit < 10; digit++) ZERO_OF.set(start + digit, digit)

/** The ASCII digit a code point stands for in one of the blocks, or null. */
export function asciiDigit(codePoint: number): string | null {
  const digit = ZERO_OF.get(codePoint)
  return digit === undefined ? null : String(digit)
}
