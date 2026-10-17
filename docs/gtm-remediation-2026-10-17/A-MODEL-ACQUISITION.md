# G18-R — pinned official model acquisition

Base: `31339e0cc15478538ce6085fa808374cb2d08bf9`. Owner: Implementer A, isolated branch `fix/gtm-model-acquisition-20261017`. Writable paths: `scripts/fetch-face-models.ts`, `scripts/fetch-face-models-download.ts`, its adjacent test, and this record.

## Reproduction and change

MQ's pristine image build terminated while reading the official pinned SFace full response after approximately 35.75 MB of 38.70 MB; the build failed and produced no accepted image. This was a body-download failure, not an OOM. MQ separately demonstrated official 1 MiB and final 6353-byte range responses. Original full-body attempt ran 14:05:26–14:17:10 UTC with OOM false. MQ preserved `evidence/sface-fetch-boundary-diagnostic.jsonl` and `evidence/sface-range-1mb-diagnostic.json` under its private runtime directory.

The fetch script now acquires each file sequentially in 1 MiB ranges. Each 206 must match the requested start, bounded end and stable positive total, and both range length and any declared Content-Length must match the actual bytes. A server may return a complete 200 only before any ranges have accumulated. Invalid responses, body termination and final digest mismatch fail without publishing. The helper hashes the complete assembled bytes, publishes only by same-directory atomic rename after the existing pinned SHA matches, and removes its partial file on failure. An existing target remains untouched on failed replacement. Existing checksum-based cache behavior remains.

No official URL, model pin, license pin, runtime detector transformation hash, threshold, Dockerfile, package, financial rule or database schema changed. No provider was activated. There is no retry/resume policy: a failed chunk fails the attempt cleanly, and a later invocation starts anew.

## Verification

- Fail first: extracted original single-response acquisition failed the sequential multi-range regression (1 failed / 9 passed); failure retained privately at `/tmp/cf-gtm-a-browser-20261017/model-download-failfirst.log`. Initial missing-module test collection was preparation only, not counted as reproduction.
- `npx vitest run scripts/fetch-face-models-download.test.ts --maxWorkers=2`: 13 tests PASS. Covers exact sequential assembly/final short chunk, ignored-Range 200 fallback, wrong start/end/total/missing range, short body, terminated initial/later body, changing total, forbidden 200 after accumulation, HTTP failure, truncated 200, pinned SHA rejection and cleanup/preservation.
- Actual `FACE_MODEL_DIR=<new mktemp directory> npm run face-models:fetch`:PASS from an empty owned directory, using the unchanged official source URLs. YuNet 232589 bytes, SFace 38696353 bytes and all 3 licenses passed existing pinned SHA checks; NOTICE copied. No cache or asset overlay supplied. Private log `/tmp/cf-gtm-a-browser-20261017/model-official-fetch.log`; owned directory path recorded in adjacent `official-model-dir` file.
- Immediate second invocation against that owned directory:PASS, all 5 files reported present/checksum OK. Private cached-run log retained.
- `npm run ci:quick`: PASS (exit 0): application/demo TypeScript, full ESLint, mirror/docs checks and all four time-zone date gates. Final frozen-source rerun scheduled before queue admission.

No browser/product behavior changes. This branch's network proof does not establish a new image or final candidate pass. MQ must integrate the independently reviewed commit, rerun final combined gates, build a pristine immutable image and run the pending portal/staff acceptance on the resulting exact candidate. Previously green 31339 gates remain evidence only for that superseded source.
