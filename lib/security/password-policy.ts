/**
 * The password rule for every password a person chooses: client portal
 * activation, reset and change, and staff create, update and reset. A
 * password that only ever gets checked at sign-in is not re-judged, so an
 * existing password keeps working until it is next changed.
 *
 * NIST SP 800-63B §5.1.1.2 shape: a minimum length and a refusal of
 * commonly-used or easily-guessed values, no composition rules. The portal
 * guards ID numbers and bank details; it once accepted "password" (Fair Score
 * audit 2026-10-16).
 *
 * Client-safe (no imports): the forms run the same check for instant feedback,
 * the server routes are the control.
 */
export const PASSWORD_MIN_LENGTH = 10
/** bcrypt reads at most 72 bytes; past this a "longer" password is not stronger. */
export const PASSWORD_MAX_LENGTH = 200

/**
 * Words that head the breached-password lists. A password that is one of these
 * with only digits and symbols around it ("Password123!", "qwerty12345") is
 * refused, whatever its length.
 */
const COMMON_BASES = [
  "password", "passw0rd", "p@ssword", "p@ssw0rd", "qwerty", "qwertyuiop", "asdfgh", "asdfghjkl", "zxcvbn",
  "letmein", "welcome", "admin", "administrator", "login", "iloveyou", "monkey", "dragon", "master",
  "football", "soccer", "baseball", "sunshine", "princess", "shadow", "superman", "batman", "starwars",
  "trustno1", "whatever", "freedom", "hello", "abc", "abcdef", "changeme", "secret", "default", "test",
  "loveme", "lovely", "flower", "computer", "internet", "michael", "jesus", "jesuslovesme", "blessed",
  "god", "godisgood", "summer", "winter", "spring", "autumn", "january", "december",
  "southafrica", "mzansi", "springbok", "springboks", "bafana", "bafanabafana", "kaizerchiefs",
  "orlandopirates", "johannesburg", "capetown", "durban", "pretoria", "soweto", "sandton",
  "fairscore", "credaflow", "portal", "client", "loan", "money", "bank", "banking", "account",
] as const

const BASE_WITH_SUFFIX = new RegExp(
  `^[0-9!@#$%^&*._\\-+=?]*(?:${COMMON_BASES.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})[0-9!@#$%^&*._\\-+=?]*$`,
)

/** Keyboard and counting runs that pass the length rule on their own. */
const RUNS = [
  "01234567890123456789", "12345678901234567890", "98765432109876543210",
  "abcdefghijklmnopqrstuvwxyz", "qwertyuiopasdfghjklzxcvbnm",
  "1q2w3e4r5t6y7u8i9o0p", "q1w2e3r4t5y6u7i8o9p0", "1qaz2wsx3edc4rfv", "zaq12wsxcde3", "qazwsxedcrfv",
]

function isRunOrRepeat(lower: string): boolean {
  if (/^(.)\1+$/.test(lower)) return true
  // A short block repeated ("abcabcabcabc", "12121212121").
  if (/^(.{1,4})\1{2,}.{0,3}$/.test(lower)) return true
  const alnum = lower.replace(/[^a-z0-9]/g, "")
  return alnum.length >= PASSWORD_MIN_LENGTH - 2 && RUNS.some((run) => run.includes(alnum))
}

/** The reason a chosen password is refused, or null when it is acceptable. */
export function passwordPolicyError(password: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `Use at least ${PASSWORD_MIN_LENGTH} characters.`
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    return `Use at most ${PASSWORD_MAX_LENGTH} characters.`
  }
  const lower = password.toLowerCase().trim()
  if (BASE_WITH_SUFFIX.test(lower) || isRunOrRepeat(lower)) {
    return "That password is too common or too easy to guess. Choose a different one."
  }
  return null
}
