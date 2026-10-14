export function portalBusinessLinkVisible(
  featureEnabled: boolean,
  authorisedEntityCount: number,
  signerCount: number,
): boolean {
  return featureEnabled && (authorisedEntityCount > 0 || signerCount > 0)
}
