import { writeFile } from "node:fs/promises"
import { isAbsolute, join } from "node:path"
import { isDeployedBuild } from "@/lib/integrations/simulation-guard"
import type { SubmissionMode } from "./layout"

// How a generated file reaches the bureau. A transport carries bytes the
// ledger already re-rendered and verified (push.ts); it never builds a file.
//
// No transport is LIVE. Experian has not confirmed the channel (SFTP or API,
// host, folder, key, PGP, file extension) and SACRRA membership is pending,
// so the only working transport is a local directory for TEST files.

export interface SubmissionFile {
  fileName: string
  content: string
  sha256: string
}

export type SubmissionTransportErrorCode = "NOT_CONFIGURED" | "NOT_IMPLEMENTED" | "DELIVERY_FAILED"

export class SubmissionTransportError extends Error {
  constructor(public readonly code: SubmissionTransportErrorCode, message: string) {
    super(message)
    this.name = "SubmissionTransportError"
  }
}

export interface SubmissionTransport {
  readonly id: string
  /** The modes this transport may carry. None carries LIVE yet. */
  readonly modes: readonly SubmissionMode[]
  /** Delivers the file; resolves with where it went. Throws SubmissionTransportError. */
  deliver(file: SubmissionFile): Promise<{ location: string }>
}

/**
 * TEST files into a local directory, for development and the integration
 * suites. A file carries every reported client's personal data, and this
 * module's rule is that files are not written to disk on a real deployment,
 * so this transport refuses a deployed build outright. It never overwrites.
 */
export function localDirectoryTransport(directory: string): SubmissionTransport {
  if (!isAbsolute(directory)) {
    throw new SubmissionTransportError("NOT_CONFIGURED", "The bureau TEST outbox must be an absolute path")
  }
  return {
    id: "local-directory",
    modes: ["TEST"],
    async deliver(file) {
      if (isDeployedBuild()) {
        throw new SubmissionTransportError("NOT_CONFIGURED", "The local bureau TEST outbox is refused on a deployed build")
      }
      // The file name is ours (bureauFileName), but never trust it as a path.
      if (!/^[A-Za-z0-9_.-]+$/.test(file.fileName) || /^\.+$/.test(file.fileName)) {
        throw new SubmissionTransportError("DELIVERY_FAILED", "Bureau file name is not a plain file name")
      }
      const location = join(directory, file.fileName)
      try {
        await writeFile(location, file.content, { encoding: "latin1", flag: "wx", mode: 0o600 })
      } catch (error) {
        const code = typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : "unknown"
        throw new SubmissionTransportError("DELIVERY_FAILED", `Local bureau outbox write failed (${code})`)
      }
      return { location }
    },
  }
}

/** Connection settings an SFTP transport will need; the bureau supplies all of them. */
export interface SftpTransportConfig {
  host: string
  port: number
  username: string
  /** secret-box sealed private key (lib/crypto/secret-box.ts). */
  privateKeySealed: string
  /** SHA-256 host-key fingerprint to pin; a mismatch must refuse the upload. */
  hostKeySha256: string
  remoteDirectory: string
  /** Whether the bureau requires the file PGP-encrypted, and to which key. */
  pgpPublicKey: string | null
}

/**
 * SKELETON. No SFTP client is a dependency of this repository (ssh2 /
 * ssh2-sftp-client would be new), and the channel itself is unconfirmed, so
 * this refuses every delivery. Building it needs: the dependency decision, the
 * bureau's host, port, folder, host key, file-naming and PGP requirements, and
 * a REJECTED-file path that releases once-only statuses (see .claude.md).
 */
export function sftpTransport(_config: SftpTransportConfig): SubmissionTransport {
  return {
    id: "sftp",
    modes: [],
    async deliver() {
      throw new SubmissionTransportError("NOT_IMPLEMENTED", "SFTP bureau transport is not built: no channel confirmed")
    },
  }
}

/** The TEST transport this environment declares, or null. */
export function testTransportFromEnv(): SubmissionTransport | null {
  const directory = process.env.BUREAU_SUBMISSION_TEST_OUTBOX?.trim()
  return directory ? localDirectoryTransport(directory) : null
}
