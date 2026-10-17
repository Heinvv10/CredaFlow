// The fixed periods of a lease's end of term (slice 3, C7), in a module with
// no imports so the lease documents can print them (documents/wording/) without
// loading the servicing code. ./lease-end-of-term.ts and ./lease-end-invoice.ts
// re-export them.

/** Months before the last rental that the end-of-term choice opens. */
export const ELECTION_WINDOW_MONTHS = 6
/** A month-to-month extension ends this many months after notice. // Notice period signed off by the lender's legal team, 2026-10-17. */
export const EXTENSION_NOTICE_MONTHS = 1
/** Days after its issue that an end-of-term, purchase or sale invoice falls due. */
export const END_OF_TERM_PAYMENT_DAYS = 7
