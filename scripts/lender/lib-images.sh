# shellcheck shell=bash
# Image helpers for the lender scripts (sourced by lib.sh): tools image, builds from a git
# archive, image ids and the lender-slug label check.

# tools_image_of REPO:TAG — the matching image that holds the CLIs (prisma, tsx, the scripts).
tools_image_of() { echo "${1%:*}-tools:${1##*:}"; }

image_commit() { docker image inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$1" | sed -n 's/^GIT_SHA=//p'; }

# build_images IMAGE TOOLS — build both targets of the Dockerfile from a clean
# `git archive` export of HEAD in a temp dir, NEVER from the working tree: the
# Dockerfile does `COPY . .`, and a working tree holds gitignored files (.env.*,
# *.pem, uploads/, the OCR corpus of real client documents) that must not ship.
# The image is `runner`; the tools image is the `builder` stage (prisma CLI, tsx,
# the scripts), which the runner image lacks. Still refuses a dirty tree: the
# image would not contain the changes you are looking at. BUILD_TIME is the
# commit's time, so a rebuild of the same commit is fully cached. Both images
# carry the labels io.credaflow.lender-slug and io.credaflow.git-sha; deploy.sh
# refuses an image built for another lender.
build_images() {
  local image="$1" tools="$2" args v ctx rc=0
  git -C "$REPO_ROOT" rev-parse --git-dir >/dev/null 2>&1 || die "refusing to build: $REPO_ROOT is not a git checkout"
  [ -z "$(git -C "$REPO_ROOT" status --porcelain)" ] \
    || die "refusing to build: working tree at $REPO_ROOT is dirty (commit or stash first; the image would match no commit)"
  args=(--build-arg "GIT_SHA=$(git -C "$REPO_ROOT" rev-parse --short=12 HEAD)"
        --build-arg "BUILD_TIME=$(git -C "$REPO_ROOT" show -s --format=%cI HEAD)"
        --build-arg "NEXT_PUBLIC_TENANT_SLUG=$SLUG"
        --label "io.credaflow.lender-slug=$SLUG"
        --label "io.credaflow.git-sha=$(git -C "$REPO_ROOT" rev-parse HEAD)")
  for v in "${BUILD_PUBLIC_VARS[@]}"; do
    [ -z "$(env_get "$ENV_FILE" "$v")" ] || args+=(--build-arg "$v=$(env_get "$ENV_FILE" "$v")")
  done
  ctx="$(mktemp -d)"
  git -C "$REPO_ROOT" archive --format=tar HEAD | tar -x -C "$ctx" || { rm -rf "$ctx"; die "git archive of HEAD failed"; }
  note "building $image and $tools from an export of $(git -C "$REPO_ROOT" rev-parse --short=12 HEAD) (tracked files only)"
  { docker build "${args[@]}" --target runner -t "$image" "$ctx" && docker build "${args[@]}" --target builder -t "$tools" "$ctx"; } || rc=$?
  rm -rf "$ctx"
  [ "$rc" -eq 0 ] || die "docker build failed"
}

# image_id REF — the immutable id (sha256:…) a tag or id currently names.
image_id() { docker image inspect -f '{{.Id}}' "$1"; }

# check_image_lender REF — refuse an image that was not built for THIS lender:
# NEXT_PUBLIC_TENANT_SLUG is baked into the bundle, so another lender's image would
# pass /api/health and then fail every tenant page. An image without the
# io.credaflow.lender-slug label cannot be verified and is refused too.
check_image_lender() {
  local got
  got="$(docker image inspect -f '{{index .Config.Labels "io.credaflow.lender-slug"}}' "$1")" || die "cannot inspect image $1"
  [ "$got" = "$SLUG" ] || die "refusing: image $1 was built for lender '${got:-<no label>}', not '$SLUG' (build it with deploy.sh --build or provision-lender.sh --build for this lender)"
}

# ensure_images IMAGE BUILD(true|false) — both images present locally.
ensure_images() {
  local image="$1" build="$2" tools i
  [[ "$image" == *:* ]] || die "image '$image' needs an explicit tag (name:tag)"
  tools="$(tools_image_of "$image")"
  if [ "$build" = true ]; then build_images "$image" "$tools"; return; fi
  for i in "$image" "$tools"; do
    docker image inspect "$i" >/dev/null 2>&1 && continue
    note "pulling $i"
    docker pull "$i" >/dev/null || die "cannot find or pull $i (use --build from a clean checkout, or publish both images)"
  done
}
