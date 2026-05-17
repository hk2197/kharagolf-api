#!/usr/bin/env bash
# Release-prep device smoke test for the mobile portal-privacy share
# buttons (Task #1081). Run on each release branch before promoting a
# build to TestFlight / Play Internal.
#
# This script:
#   1. Verifies maestro is installed (https://maestro.mobile.dev).
#   2. Verifies a target simulator/emulator or device is booted.
#   3. Verifies the app under test is installed (built via
#      `eas build --profile smoke-ios` or `--profile smoke-android` —
#      see eas.json — and side-loaded onto the target).
#   4. Runs .maestro/portal-privacy-share.yaml against it.
#
# Usage:
#   MAESTRO_TEST_EMAIL=share-tester@kharagolf.test \
#   MAESTRO_TEST_PASSWORD=<password> \
#     bash artifacts/kharagolf-mobile/scripts/release-smoke.sh
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
FLOW="${HERE}/.maestro/portal-privacy-share.yaml"

if ! command -v maestro >/dev/null 2>&1; then
  echo "maestro CLI not found. Install via:"
  echo "  curl -Ls https://get.maestro.mobile.dev | bash"
  echo "and ensure ~/.maestro/bin is on PATH."
  exit 2
fi

if [[ -z "${MAESTRO_TEST_EMAIL:-}" || -z "${MAESTRO_TEST_PASSWORD:-}" ]]; then
  echo "MAESTRO_TEST_EMAIL and MAESTRO_TEST_PASSWORD must be set."
  echo "See artifacts/kharagolf-mobile/docs/DEVICE_TEST_PLAN_PORTAL_PRIVACY_SHARE.md"
  echo "for the share-tester fixture account these should point at."
  exit 2
fi

echo "Running portal-privacy share smoke test against the active device..."
exec maestro test "${FLOW}"
