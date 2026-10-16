// The deal's exceptions on the credit memo (lib/asset-finance/deal-exceptions.ts):
// internal arrears of the borrower or its people, and directors' or trustees'
// bureau checks not on record. Approval needs a reason for them. No hooks.

export function DealExceptionsNotice({ lines }: { lines: string[] }) {
  if (lines.length === 0) return null
  return (
    <div role="alert" className="mb-4 rounded-lg border border-[rgba(217,154,58,0.28)] bg-[rgba(217,154,58,0.08)] p-3 text-sm">
      <p className="font-semibold text-[var(--cf-text)]">Exceptions: approval needs a reason for each of these</p>
      <ul className="ml-5 mt-1 list-disc text-[var(--cf-text-secondary)]">
        {lines.map((line) => <li key={line}>{line}</li>)}
      </ul>
    </div>
  )
}
