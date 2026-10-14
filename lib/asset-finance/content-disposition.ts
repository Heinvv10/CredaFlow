/** A Content-Disposition value with an ASCII fallback and RFC 5987 filename. */
export function entityDocumentDisposition(
  disposition: "inline" | "attachment",
  name: string,
  sanitise: (name: string) => string,
): string {
  const safeName = sanitise(name)
  const asciiName = safeName.replace(/[^\x20-\x7e]/g, "_")
  const encodedName = encodeURIComponent(safeName).replace(/[!'()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  )
  return `${disposition}; filename="${asciiName}"; filename*=UTF-8''${encodedName}`
}
