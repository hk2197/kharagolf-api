#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Wear OS unit-test runner (Task #1978).
#
# Runs the JUnit + Robolectric suite for `:wear-os-module` so the
# Project workflow turns red whenever the offline-queue eviction
# behaviour from Task #1589 (or the persistence round-trip behind
# OfflineQueuePersistenceTest) regresses.
#
# Scope is intentionally narrowed to the offline-queue tests via
# `--tests` because `WatchFaceOverflowSnapshotTest` requires
# Robolectric Native Graphics + libfreetype, which the Replit Nix
# store does not provide. The remaining tests pass with
# `-Drobolectric.graphicsMode=LEGACY`.
# ---------------------------------------------------------------------------
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

bash "$REPO_ROOT/scripts/setup-android-sdk.sh"

export ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-$HOME/.android-sdk}"
export ANDROID_HOME="$ANDROID_SDK_ROOT"

cd "$REPO_ROOT/artifacts/kharagolf-mobile/wear-os-module"

# Single-use daemon so the workflow doesn't leak gradle processes
# between runs. console=plain keeps the workflow log readable.
exec gradle \
    --no-daemon \
    --console=plain \
    --warning-mode=summary \
    -Drobolectric.graphicsMode=LEGACY \
    :testDebugUnitTest \
    --tests 'com.kharagolf.wearos.OfflineQueuePersistenceTest'
