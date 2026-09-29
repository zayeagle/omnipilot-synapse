#!/usr/bin/env bash
#
# One-click packaging for OmniPilot Synapse.
#
# Modes:
#   chrome     build + zip the Chrome/Edge MV3 bundle
#   firefox    build + zip the Firefox bundle
#   companion  build + test + single-file bundle the native-messaging companion (apps/git-bridge)
#   all        all of the above (default)
#   verify     run the full verification pipeline for both packages (no packages)
#
# Options:
#   --dry-run      print every step without executing it
#   --build-only   build, skip zipping/bundling
#   --skip-test    skip the unit/integration/system suites (faster local iteration)
#   --production   require ENV=production to be set (guard against accidental release packaging)
#
# Exit codes: 0 success, 1 failure (with a clear message and a non-zero status).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
EXT="$ROOT/apps/extension"
COMPANION="$ROOT/apps/git-bridge"

case "${1:-}" in
  -h|--help|help)
    sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'
    exit 0
    ;;
esac

MODE="${1:-all}"
shift || true

DRY_RUN=0
BUILD_ONLY=0
SKIP_TEST=0
PRODUCTION=0

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --build-only) BUILD_ONLY=1 ;;
    --skip-test) SKIP_TEST=1 ;;
    --production) PRODUCTION=1 ;;
    -h|--help)
      sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "unknown option: $arg" >&2
      exit 1
      ;;
  esac
done

# Each package has its own working directory; the extension steps used to assume one implicitly.
step_in() {
  local cwd="$1" label="$2" command="$3"
  echo ""
  echo "▶ $label"
  echo "  \$ $command"
  if [ "$DRY_RUN" -eq 0 ]; then
    # shellcheck disable=SC2086
    (cd "$cwd" && eval "$command")
  fi
}

step() {
  step_in "$EXT" "$1" "$2"
}

# The companion is only needed by the modes that touch it, so its dependencies are checked lazily —
# `chrome`/`firefox` must keep working on a machine that has never installed the companion.
require_companion() {
  if [ "$DRY_RUN" -eq 0 ] && [ ! -d "$COMPANION/node_modules" ]; then
    echo "✗ companion dependencies are missing — run: npm --prefix apps/git-bridge install" >&2
    exit 1
  fi
}

preflight() {
  echo "OmniPilot Synapse — one-click packaging"
  echo "  mode:        $MODE"
  echo "  dry run:     $DRY_RUN"
  echo "  build only:  $BUILD_ONLY"
  echo "  skip tests:  $SKIP_TEST"

  command -v node >/dev/null 2>&1 || { echo "✗ node is required but was not found" >&2; exit 1; }
  command -v npm  >/dev/null 2>&1 || { echo "✗ npm is required but was not found" >&2; exit 1; }
  [ -d "$EXT/node_modules" ] || { echo "✗ dependencies are missing — run: npm --prefix apps/extension install" >&2; exit 1; }

  if [ "$PRODUCTION" -eq 1 ] && [ "${ENV:-}" != "production" ]; then
    echo "✗ --production requires ENV=production (refusing to package a release implicitly)" >&2
    exit 1
  fi
}

verify_extension() {
  step "typecheck (extension)" "npx tsc --noEmit"
  if [ "$SKIP_TEST" -eq 0 ]; then
    step "unit tests (extension)" "npm test"
    step "integration tests (extension)" "npm run test:int"
  fi
  step "content-bundle secret assertion" "npm run assert:content"
}

verify_companion() {
  require_companion
  step_in "$COMPANION" "typecheck (companion)" "npx tsc --noEmit"
  if [ "$SKIP_TEST" -eq 0 ]; then
    step_in "$COMPANION" "unit tests (companion)" "npm test"
    step_in "$COMPANION" "system tests (companion)" "npm run test:sys"
  fi
}

pack_chrome() {
  step "build (chrome MV3)" "npm run build"
  step "assert content bundle carries no secrets" "npm run assert:content"
  if [ "$BUILD_ONLY" -eq 0 ]; then
    step "zip (chrome)" "npm run zip"
  fi
}

pack_firefox() {
  step "build (firefox)" "npm run build:firefox"
  if [ "$BUILD_ONLY" -eq 0 ]; then
    step "zip (firefox)" "npm run zip:firefox"
  fi
}

pack_companion() {
  require_companion
  # `pack.mjs` owns the build/test/bundle order; these flags only decide how much of it runs.
  local args=""
  if [ "$SKIP_TEST" -eq 1 ]; then
    args="$args --skip-test"
  fi
  if [ "$BUILD_ONLY" -eq 1 ]; then
    args="$args --no-bundle"
  fi
  step_in "$COMPANION" "companion: build + tests + single-file bundle" "npm run pack${args:+ --$args}"
}

finish() {
  echo ""
  echo "════════════════════════════════════════"
  echo " Deploy Result"
  echo "  mode:     $MODE"
  echo "  duration: ${SECONDS}s"
  if [ "$BUILD_ONLY" -eq 0 ]; then
    case "$MODE" in
      chrome|firefox|all)
        echo "  artifacts: apps/extension/.output/*.zip"
        echo "  unpacked:  apps/extension/.output/{chrome-mv3,firefox-mv2}"
        echo ""
        echo "  Install: chrome://extensions → Developer mode → Load unpacked → .output/chrome-mv3"
        echo "           about:debugging#/runtime/this-firefox → Load Temporary Add-on → manifest.json"
        ;;
    esac
    case "$MODE" in
      companion|all)
        echo "  companion: apps/git-bridge/.output/git-bridge-<platform>-<arch>.mjs"
        echo ""
        echo "  Companion (native host) — preview, then register:"
        echo "    node apps/git-bridge/native-host/install.mjs --dry-run"
        echo "    node apps/git-bridge/native-host/install.mjs --browser all \\"
        echo "      --extension-id <chrome-extension-id> --firefox-id <firefox-addon-id>"
        ;;
    esac
  fi
  echo "  rollback: remove the unpacked extension, or reload the previous .zip"
  echo "            companion: delete the installed <host>.json (see deploy/README.md)"
  echo "════════════════════════════════════════"
}

preflight
case "$MODE" in
  chrome)    verify_extension; pack_chrome ;;
  firefox)   verify_extension; pack_firefox ;;
  companion) pack_companion ;;
  all)       verify_extension; pack_chrome; pack_firefox; pack_companion ;;
  verify)    verify_extension; verify_companion ;;
  *) echo "unknown mode: $MODE (expected chrome | firefox | companion | all | verify)" >&2; exit 1 ;;
esac
finish
