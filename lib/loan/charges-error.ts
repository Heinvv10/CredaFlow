// Base for every error that means "the default-charges replay cannot book this
// as things stand" — as opposed to a database or programming failure. A writer
// that has real money in hand catches it and holds the receipt for
// reconciliation instead of losing it (lib/payments/held-receipt.ts).
export class ChargesError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ChargesError"
  }
}
