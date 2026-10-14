import { FileText } from "lucide-react"
import { DEFAULT_LOCALE, type Locale } from "@/lib/i18n/locales"
import { createTranslator } from "@/lib/i18n/translate"

/**
 * Download link for the countersigned agreement on the portal application
 * page. Renders nothing until the executed document exists: before
 * countersignature only the borrower has signed and there is no signed copy to
 * offer. The link goes through the document view route, which verifies the
 * document and writes the DocumentAccessLog row.
 */
export function ExecutedAgreementCard({
  agreementExecutedDocumentId,
  locale = DEFAULT_LOCALE,
}: {
  agreementExecutedDocumentId: string | null
  locale?: Locale
}) {
  if (!agreementExecutedDocumentId) return null
  const t = createTranslator(locale, "portalApplications")
  return (
    <div className="mb-5 flex items-center justify-between gap-3 rounded-xl border border-green-200 bg-green-50 p-4">
      <div className="flex items-center gap-3">
        <FileText className="h-5 w-5 shrink-0 text-green-600" />
        <p className="text-sm font-semibold text-green-800">{t("execAgreement")}</p>
      </div>
      <a
        href={`/api/documents/${agreementExecutedDocumentId}/view?download=1`}
        target="_blank"
        rel="noopener noreferrer"
        className="whitespace-nowrap rounded-lg px-4 py-2 text-sm font-bold text-white"
        style={{ backgroundColor: "#166534" }}
      >
        {t("execDownload")}
      </a>
    </div>
  )
}
