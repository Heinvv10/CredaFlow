// A deal document that cannot be built or rendered. A module of its own so the
// pure renderers and wording can throw it without importing the loader's
// database, identity and rate graph (./deal-document-data.ts re-exports it).
export class DealDocumentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "DealDocumentError"
  }
}
