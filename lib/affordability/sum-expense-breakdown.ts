export interface ExpenseBreakdownCents {
  housing: number
  transport: number
  food: number
  education: number
  insurance: number
  clothing: number
  entertainment: number
  medical: number
  other: number
}

export function sumExpenseBreakdown(b: ExpenseBreakdownCents): number {
  return (
    b.housing +
    b.transport +
    b.food +
    b.education +
    b.insurance +
    b.clothing +
    b.entertainment +
    b.medical +
    b.other
  )
}
