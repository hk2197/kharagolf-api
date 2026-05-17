Fixture directory for `scripts/check-watch-label-coverage.mjs --self-test`.

These empty `.mc` / `.swift` / `.kt` files exercise the `discoverScreens()`
helper used by the label-coverage guard (Task #2225). The self-test
asserts that:

  - The Garmin glob `Kharagolf*.mc` picks up every player-facing view
    file (including a future `KharagolfStatsView.mc` that no contributor
    needs to remember to register), but skips files in
    `SCREEN_FILE_DENYLIST.garmin` (`KharagolfApp.mc`,
    `KharagolfBackend.mc`).
  - The iOS glob `*View.swift` and the Wear glob `*Screen.kt` mirror
    the same pattern, with their own small denylists.

If you delete a fixture file the self-test will fail loudly. Add new
fixtures here when you add new discovery scenarios to the self-test.
