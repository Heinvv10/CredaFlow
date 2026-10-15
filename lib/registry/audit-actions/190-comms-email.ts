import { defineAuditActions } from "../define"

export default defineAuditActions({
  // Comms internal notes
  COMMS_NOTE_ADDED: "COMMS_NOTE_ADDED",
  COMMS_NOTE_EDITED: "COMMS_NOTE_EDITED",
  COMMS_NOTE_DELETED: "COMMS_NOTE_DELETED",

  // Comms / inbox
  CONVERSATION_MERGED: "CONVERSATION_MERGED",

  // Email hub
  // Mail configuration is a money-and-notice path: the Section 129 statutory
  // notice goes out over whatever is configured here, so "who changed the
  // sending mailbox, and when" is an auditor question.
  EMAIL_CONFIG_UPDATED: "EMAIL_CONFIG_UPDATED",
  EMAIL_IMAP_TESTED: "EMAIL_IMAP_TESTED",
  // Backfill of the at-rest encryption for the EmailConfig secret columns.
  EMAIL_SECRETS_ENCRYPTED: "EMAIL_SECRETS_ENCRYPTED",
})
