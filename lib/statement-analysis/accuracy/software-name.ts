/**
 * A PDF's Producer/Creator for the corpus scripts' output: printed only when it
 * names known PDF software. A file a client saved can carry anything there,
 * including a person's name, so anything else prints as its length.
 */
const KNOWN_SOFTWARE = /^(Microsoft|pypdf|airSlate|iText|OpenPDF|Compart|PDFlib|OpenText|TargetStream|StreamServe|Aspose|BIRT|Designer|DocFusion|Discovery Bank|Adobe|Skia|Quartz|LibreOffice|Ghostscript|cairo|wkhtmltopdf|Chromium|Mozilla)\b/

export function softwareName(value: string | null): string {
  if (!value) return "—"
  return KNOWN_SOFTWARE.test(value) ? value.replace(/\|/g, "/").slice(0, 40) : `(other, ${value.length} chars)`
}
