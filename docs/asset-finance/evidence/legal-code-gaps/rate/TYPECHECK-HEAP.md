# Cold typecheck heap budget

The hosted quality job for `35cd5dc53bfd56983122b24d47a8008f33129d67`
(run `39100215279`, Node 22.23.3) failed at the root Typecheck step with
exit 134. The retained log records major collections at 4034.9 and 4036.8 MB
before `JavaScript heap out of memory`; it contains no TypeScript diagnostic.
The previous 4096 MiB old-space cap left insufficient headroom on that runner.

The initial change gave only the root Typecheck step a 6144 MiB default. The local
wrapper used the same default for that command and preserved an explicitly
provided `NODE_OPTIONS`. Its other commands retained the existing 4096 MiB
default, including the demo typecheck and production build. No compiler
options, included files, exclusions, checks or tests are removed.

Independent measurements use a separate clean clone of the exact source head,
its own installed dependencies, regenerated Prisma client and registries,
Node 22.23.1 via an explicit PATH, `ulimit -c 0`, and `/usr/bin/time -v`.
This local Node patch version differs from the hosted version above.

The first diagnostic run used the requested `--incremental false`. It passed
at 4096 MiB, in 58.20 s with peak RSS 4,355,956 KiB. This does **not** reproduce
the hosted failure: the actual workflow uses the tsconfig's `incremental: true`.

The actual compiler mode was then measured with unique, previously absent
`--tsBuildInfoFile` paths to guarantee cold runs without altering tsconfig.

| Command | Result | Wall time | Peak RSS |
| --- | --- | --- | --- |
| `NODE_OPTIONS=--max-old-space-size=4096 npx tsc --noEmit --tsBuildInfoFile <fresh-path>` | Exit 134, heap OOM | 59.62 s | 4,355,496 KiB |
| `NODE_OPTIONS=--max-old-space-size=6144 npx tsc --noEmit --tsBuildInfoFile <fresh-path>` | Exit 0, no diagnostics | 47.01 s | 4,707,884 KiB |
| `NODE_OPTIONS=--max-old-space-size=4096 npm run demo:typecheck` | Exit 0 | 7.53 s | 1,600,728 KiB |

The local cold incremental failure records major collections at 4036.7 and
4035.9 MB, retaining about 4020 MB, then the same fatal V8 heap message as
the hosted failure. Core dumps were disabled. No TypeScript diagnostic was
emitted.

The 6144 MiB cold incremental run passes without changing the compilation
scope. RSS includes memory outside V8 old space, so it is not the heap cap.
The independent check does not claim a new full quality/build result; those
gates must run on the final integrated commit. The production-build budget
remained explicitly 4096 MiB at this checkpoint in the workflow and local wrapper.

Initial workflow YAML parsing confirmed root/demo/build budgets of 6144/4096/4096 MiB.
`bash -n scripts/ci-local.sh`, `git diff --check`, and the existing workflow
action-pin suite (2 tests) pass. A shell command stub verified that the local
wrapper passes 6144 only to root tsc and 4096 to its other commands by default;
an explicit caller `NODE_OPTIONS=--trace-warnings` is preserved for every
command.

## Next build worker follow-up

The next hosted run passed the standalone root typecheck, then compiled the
production bundle successfully. Its independent Next TypeScript worker exhausted
the remaining 4096 MiB build cap: major collections at 4029.7 and 4030.4 MB
retained about 4015 MB, followed by the same fatal V8 heap message and
`Failed to type check`. This was a memory failure, not a TypeScript diagnostic.

The follow-up gives the Build step the same 6144 MiB budget because it checks
the same root type graph. The local wrapper shares that root-types default
between tsc and build. Demo and other commands retain 4096 MiB defaults;
explicit caller options still override both root commands. The workflow and
local wrapper now agree on root/demo/build defaults of 6144/4096/6144 MiB.
No Next typecheck is skipped, and no compilation scope or product code changes.

Independent cold builds use the same clone and explicit Node 22.23.1 PATH.
The complete `.next` tree from the 4096 MiB attempt was moved aside before
the 6144 MiB run, so the second run cannot reuse its TypeScript or bundle cache.
Core dumps remain disabled.

| Cold production build | Result | Wall time | Peak RSS |
| --- | --- | --- | --- |
| `NODE_OPTIONS=--max-old-space-size=4096 npm run build` | Exit 1; TypeScript worker heap OOM | 73.10 s | 4,360,096 KiB |
| `NODE_OPTIONS=--max-old-space-size=6144 npm run build` | Exit 0; full production build passed | 58.43 s | 4,752,064 KiB |

The local failure compiled the bundle, then exhausted the TypeScript worker
at about 4033 MB, retaining about 4018 MB, before `Failed to type check`.
This independently reproduces the hosted failure stage and cause.

The 6144 MiB run compiled successfully, finished the full Next TypeScript
check in 44 s, generated all 282 static pages and finalized the production
output. Both measurements used cold caches and the same dependencies/source.
The final follow-up YAML parses, shell syntax and diff checks pass, and a
stubbed complete local quality run confirms root/demo/build defaults of
6144/4096/6144 MiB while retaining explicit caller options for all three.
