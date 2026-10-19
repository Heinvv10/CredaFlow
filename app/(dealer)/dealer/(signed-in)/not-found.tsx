import Link from "next/link"
import { DealerPageTitle } from "@/components/dealer/DealerShell"

// The dealer portal's 404 for a signed-in dealer: another dealer's or lender's
// deal, or one that does not exist (lib/dealer/.claude.md, "The 404 rule").
// Rendered inside the portal shell, instead of the root not-found, whose
// "Apply online" links are the public site's and 404 on the dealer host.
export default function DealerNotFound() {
  return (
    <>
      <DealerPageTitle title="Not found" subtitle="There is nothing here for your dealership." />
      <Link href="/dealer" className="text-sm text-[var(--cf-brand-alt)] hover:underline">Back to your deals</Link>
    </>
  )
}
