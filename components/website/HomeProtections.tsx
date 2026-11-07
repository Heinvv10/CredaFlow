import { CheckCircle2, ShieldCheck } from "lucide-react"
import type { LenderIdentity } from "@/lib/config/identity-schema"
import type { MessageKey, Translator } from "@/lib/i18n/translate"

const protections: MessageKey<"websiteHome">[] = ["protection1", "protection2", "protection3", "protection4"]

/** The home page's "How you're protected" section: NCA, POPIA and Ombud statements, so South African lenders only. */
export function HomeProtections({ identity, t }: { identity: LenderIdentity; t: Translator<"websiteHome"> }) {
  return (
    <section className="hidden border-t border-white/10 bg-[#11141b] px-4 py-20 sm:px-6 md:block lg:px-8">
      <div className="mx-auto grid max-w-7xl gap-12 lg:grid-cols-[0.9fr_1.1fr]">
        <div>
          <div className="flex h-11 w-11 items-center justify-center border border-[#a5b4fc]/35 bg-[#a5b4fc]/12 text-[#a5b4fc]">
            <ShieldCheck className="h-5 w-5" />
          </div>
          <p className="mt-6 text-xs font-semibold uppercase tracking-[0.28em] text-[#a5b4fc]">{t("howProtected")}</p>
          <h2 className="mt-4 text-balance text-4xl font-semibold tracking-normal text-white">
            {t("protectedHeading")}
          </h2>
          {/* The sentence claims FSP authorisation; it is not translated without it. */}
          {identity.fspNumber && identity.ncrNumber && (
            <p className="mt-5 text-lg leading-8 text-white/66">
              {t("protectedBody", { legalName: identity.legalName, ncr: identity.ncrNumber, fsp: identity.fspNumber })}
            </p>
          )}
        </div>
        <div className="grid gap-3">
          {protections.map((p) => (
            <div key={p} className="flex items-start gap-3 border border-white/12 bg-white/[0.04] px-5 py-4">
              <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-[#a5b4fc]" />
              <span className="text-sm leading-7 text-white/72">{t(p)}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
