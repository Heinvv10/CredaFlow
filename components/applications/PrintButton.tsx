"use client"

import { Button } from "@/components/ui/button"

/** Opens the browser's print dialog (the committee pack is a printable page: print it, or save it as a PDF). */
export function PrintButton({ label = "Print or save as PDF" }: { label?: string }) {
  return <Button type="button" variant="outline" className="print:hidden" onClick={() => window.print()}>{label}</Button>
}
