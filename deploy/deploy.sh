#!/usr/bin/env bash
#
# Unified one-click entry point for OmniPilot Synapse.
#
# This project ships a BROWSER EXTENSION plus a NATIVE-MESSAGING COMPANION, not a server, so the
# three deploy modes of the generic template (docker / k8s / binary) do not apply — there is nothing
# to containerise or schedule. The modes here are the deliverable equivalents: installable packages
# for each browser family, and a single-file bundle for the companion process.
#
# Usage:
#   ./deploy/deploy.sh [chrome|firefox|companion|all|verify] [--dry-run] [--build-only] [--skip-test]

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
case "${1:-}" in
  -h|--help|help)
    sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
    exec "$ROOT/deploy/pack/deploy.sh" --help
    ;;
esac

MODE="${1:-all}"
shift || true

exec "$ROOT/deploy/pack/deploy.sh" "$MODE" "$@"
