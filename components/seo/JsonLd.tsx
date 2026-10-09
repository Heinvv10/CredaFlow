interface JsonLdProps {
  /** Stable id prefix used to key the script element(s). */
  id: string
  /** A single JSON-LD object, or an array to emit multiple <script> tags. */
  data: object | object[]
}

/**
 * Render JSON-LD structured data as inline <script type="application/ld+json">
 * via dangerouslySetInnerHTML. This is the pattern documented in the Next.js
 * App Router JSON-LD guide — it puts the JSON in the SSR HTML so crawlers and
 * AI answer engines see it on the first fetch.
 *
 * Why not next/script: with the default `afterInteractive` strategy, next/script
 * injects the tag client-side after hydration via textContent. The SSR HTML
 * would contain no JSON-LD, defeating the purpose for crawlers.
 *
 * Why dangerouslySetInnerHTML: React HTML-escapes text children of raw elements
 * (including <script>), which would mangle JSON values containing "&" or ">"
 * (common in URL query strings).
 *
 * XSS surface: the JSON payload is built in lib/seo/jsonld.ts from code
 * constants and the admin-entered lender identity. The only realistic breakout
 * vector is a description containing the literal "</script>" — defended against
 * by escaping "<" to its JSON-equivalent "\\u003c", which keeps the JSON valid
 * while preventing the tag from closing early.
 */
export function JsonLd({ id, data }: JsonLdProps) {
  const items = Array.isArray(data) ? data : [data]
  return (
    <>
      {items.map((item, index) => {
        const safeJson = JSON.stringify(item).replace(/</g, "\\u003c")
        return (
          <script
            key={`${id}-${index}`}
            type="application/ld+json"
            dangerouslySetInnerHTML={{ __html: safeJson }}
          />
        )
      })}
    </>
  )
}
