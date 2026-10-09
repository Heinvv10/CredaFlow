"use client"

export function PrintButton() {
  return (
    <button
      className="px-3 py-1.5 rounded border text-xs font-semibold print:hidden"
      style={{ borderColor: "#4338CA", color: "#4338CA" }}
      onClick={() => window.print()}
    >
      Print
    </button>
  )
}
