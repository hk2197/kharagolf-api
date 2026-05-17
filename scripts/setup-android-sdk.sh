#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Idempotent Android SDK installer for Replit container builds.
#
# Used by `scripts/run-wear-os-tests.sh` (Task #1978) so the
# `wear-os-test` workflow can run JUnit + Robolectric unit tests for
# the Wear OS module without baking the SDK into the Nix store.
#
# Installs into $HOME/.android-sdk (gitignored). Re-runs short-circuit
# once the requested platform / build-tools are present.
# ---------------------------------------------------------------------------
set -euo pipefail

SDK_ROOT="${ANDROID_SDK_ROOT:-$HOME/.android-sdk}"
CMDLINE_VER="11076708"
PLATFORM_VER="34"
BUILD_TOOLS_VER="34.0.0"

mkdir -p "$SDK_ROOT/cmdline-tools"

CMDLINE_BIN="$SDK_ROOT/cmdline-tools/latest/bin/sdkmanager"
if [[ ! -x "$CMDLINE_BIN" ]]; then
  echo ">> Downloading Android cmdline-tools $CMDLINE_VER"
  TMP_ZIP="$(mktemp).zip"
  curl -fsSL -o "$TMP_ZIP" \
    "https://dl.google.com/android/repository/commandlinetools-linux-${CMDLINE_VER}_latest.zip"
  unzip -q -o "$TMP_ZIP" -d "$SDK_ROOT/cmdline-tools"
  rm -f "$TMP_ZIP"
  # The zip extracts to "cmdline-tools/cmdline-tools/" — sdkmanager
  # expects "cmdline-tools/latest/" so we move it into place.
  rm -rf "$SDK_ROOT/cmdline-tools/latest"
  mv "$SDK_ROOT/cmdline-tools/cmdline-tools" "$SDK_ROOT/cmdline-tools/latest"
fi

export ANDROID_SDK_ROOT="$SDK_ROOT"
export ANDROID_HOME="$SDK_ROOT"

# Accept all licenses up-front so the installer doesn't prompt.
yes 2>/dev/null | "$CMDLINE_BIN" --sdk_root="$SDK_ROOT" --licenses >/dev/null 2>&1 || true

NEEDED=(
  "platform-tools"
  "platforms;android-${PLATFORM_VER}"
  "build-tools;${BUILD_TOOLS_VER}"
)

MISSING=()
for pkg in "${NEEDED[@]}"; do
  case "$pkg" in
    "platform-tools") [[ -d "$SDK_ROOT/platform-tools" ]] || MISSING+=("$pkg") ;;
    "platforms;android-"*) [[ -d "$SDK_ROOT/platforms/android-${PLATFORM_VER}" ]] || MISSING+=("$pkg") ;;
    "build-tools;"*) [[ -d "$SDK_ROOT/build-tools/${BUILD_TOOLS_VER}" ]] || MISSING+=("$pkg") ;;
  esac
done

if [[ ${#MISSING[@]} -gt 0 ]]; then
  echo ">> Installing missing SDK packages: ${MISSING[*]}"
  "$CMDLINE_BIN" --sdk_root="$SDK_ROOT" "${MISSING[@]}" >/dev/null
fi

echo ">> Android SDK ready at $SDK_ROOT"
