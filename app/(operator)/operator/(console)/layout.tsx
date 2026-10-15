import { requireOperatorPage } from "@/lib/operator/console-auth"
import { OperatorShell } from "@/components/operator/OperatorShell"

export const dynamic = "force-dynamic"

export const metadata = { title: "Operator console" }

// Every page below repeats requireOperatorPage itself: a page renders in
// parallel with its layout, so this one gates the frame, not the data.
export default async function OperatorConsoleLayout({ children }: { children: React.ReactNode }) {
  const principal = await requireOperatorPage()
  return <OperatorShell user={{ email: principal.email, role: principal.role }}>{children}</OperatorShell>
}
