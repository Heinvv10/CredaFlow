import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// sha_from_tag of upgrade-stack.lib.sh: pure, called from a shell that sources it.

const LIB = join(__dirname, 'upgrade-stack.lib.sh')

function shaFromTag(tag: string, prefix: string): string {
  const r = spawnSync('bash', ['-c', '. "$0"; sha_from_tag "$@"', LIB, tag, prefix], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`sha_from_tag: ${r.stderr}`)
  return r.stdout
}

describe('sha_from_tag', () => {
  it.each([
    ['credaflow:fairscore-6d18489', 'fairscore', '6d18489'],
    ['fairscore-0c362f0-banner', 'fairscore', '0c362f0'],
    ['credaflow:demo-6d18489-dirty-0123abcd', 'demo', '6d18489'],
    ['credaflow:fairscore-6d18489abcdef0123456789abcdef0123456789a', 'fairscore', '6d18489abcdef0123456789abcdef0123456789a'],
    // The prefix itself is never the commit, even when it looks like hex.
    ['credaflow:deadbeef-0c362f0', 'deadbeef', '0c362f0'],
    // A tag that does not start with the expected prefix still loses its first word.
    ['credaflow:other-0c362f0', 'fairscore', '0c362f0'],
  ])('%s (prefix %s) is commit %s', (tag, prefix, sha) => {
    expect(shaFromTag(tag, prefix)).toBe(sha)
  })

  it.each([
    ['credaflow:fairscore-banner', 'fairscore'],
    ['credaflow:fairscore-latest', 'fairscore'],
    ['credaflow:fairscore-abc123', 'fairscore'],
    ['credaflow:fairscore-0c362f0x', 'fairscore'],
    ['', 'fairscore'],
  ])('%j holds no commit', (tag, prefix) => {
    expect(shaFromTag(tag, prefix)).toBe('')
  })
})
