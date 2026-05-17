// Task #1979 — phone-bridge-level coverage for the offline-eviction
// notice path. The bridge plugin (`withWatchBridge.js`) injects native
// iOS/Android source at expo-prebuild time; the injected code only runs
// at runtime on real devices, so we can't unit-test the listener
// callbacks themselves under `node --test`. What we CAN do is assert
// that the plugin renders the expected receivers, payload-parsing
// shape, notification helpers, and JS-event hooks into the native
// source — which is what would actually break if a future refactor
// dropped the wiring on the floor.
//
// The plugin module exports a single function (the Expo config plugin)
// and stashes the iOS/Android template strings as module-internal
// constants. We re-read the file as text and assert against it
// directly so a refactor that moves the templates out of inline
// constants doesn't silently break this test.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const pluginSource = readFileSync(join(here, "withWatchBridge.js"), "utf8");

// Split the file into the two template-string blocks so each test
// asserts against exactly the right native-language section. We pick
// the iOS block by the `import WatchConnectivity` marker and the
// Android block by the `package com.kharagolf.mobile` marker; both
// markers exist exactly once in the file.
function extractIOSTemplate() {
  // The iOS impl template lives between `const IOS_BRIDGE_IMPL = \`` and the
  // next backtick. Pull it directly so we don't accidentally match against
  // the iOS *header* template (which is a forward-declaration .m file and
  // doesn't carry the eviction logic).
  const start = pluginSource.indexOf("const IOS_BRIDGE_IMPL = `");
  const end   = pluginSource.indexOf("`.trim();", start);
  assert.ok(start >= 0 && end > start, "could not locate IOS_BRIDGE_IMPL block");
  return pluginSource.slice(start, end);
}

function extractAndroidTemplate() {
  const start = pluginSource.indexOf("const ANDROID_BRIDGE_IMPL = `");
  const end   = pluginSource.indexOf("`.trim();", start);
  assert.ok(start >= 0 && end > start, "could not locate ANDROID_BRIDGE_IMPL block");
  return pluginSource.slice(start, end);
}

// ── iOS receiver shape ────────────────────────────────────────────────

test("iOS bridge imports UserNotifications so it can post local notifications", () => {
  const ios = extractIOSTemplate();
  assert.match(ios, /import\s+UserNotifications/,
               "UserNotifications import must be present so UNUserNotificationCenter resolves");
});

test("iOS bridge handles the watchOfflineEviction key in handleIncoming", () => {
  const ios = extractIOSTemplate();
  // The handler reads BOTH the count and the oldest-timestamp from the
  // payload — without both the notification body would be wrong.
  assert.match(ios, /payload\["watchOfflineEviction"\]/,
               "iOS handleIncoming must check the watchOfflineEviction payload key");
  assert.match(ios, /evict\["count"\]/,
               "iOS receiver must read the count field");
  assert.match(ios, /evict\["oldestEvictedTimestampMs"\]/,
               "iOS receiver must read the oldestEvictedTimestampMs field");
});

test("iOS bridge calls postOfflineEvictionNotification when payload is valid", () => {
  const ios = extractIOSTemplate();
  // Wiring: receiver invokes the notification helper.
  assert.match(ios, /postOfflineEvictionNotification\(count:\s*count,\s*oldestEvictedTimestampMs:\s*oldestMs\)/,
               "iOS receiver must hand the parsed payload to the notification helper");
  // The helper itself exists and uses UNUserNotificationCenter.
  assert.match(ios, /private\s+func\s+postOfflineEvictionNotification/,
               "iOS notification helper must be defined");
  assert.match(ios, /UNUserNotificationCenter\.current\(\)/,
               "iOS notification helper must schedule via UNUserNotificationCenter");
  assert.match(ios, /UNMutableNotificationContent\(\)/,
               "iOS notification helper must build a UNMutableNotificationContent");
});

test("iOS bridge respects notification permission status (best-effort)", () => {
  const ios = extractIOSTemplate();
  // Don't pester users who haven't granted notif permission.
  assert.match(ios, /\.authorizationStatus\s*==\s*\.authorized/,
               "iOS notification helper must check notif permission before scheduling");
});

test("iOS bridge dedupes notifications by oldest-eviction timestamp", () => {
  const ios = extractIOSTemplate();
  // The identifier is keyed on the timestamp so a re-delivery of the
  // same payload coalesces into the same notification. The JS file
  // double-escapes the Swift `\(...)` interpolation so we look for the
  // literal raw substring rather than a regex.
  assert.ok(ios.includes("kharagolf.offline-eviction.\\\\(oldestEvictedTimestampMs)"),
            "iOS notification id must include the oldest-eviction timestamp for dedupe");
});

test("iOS bridge declares KharagolfWatchEvictionNotice as a supported JS event", () => {
  const ios = extractIOSTemplate();
  assert.match(ios, /supportedEvents.*KharagolfWatchEvictionNotice/s,
               "iOS supportedEvents must include the eviction-notice event for JS subscribers");
  assert.match(ios, /sendEvent\(withName:\s*"KharagolfWatchEvictionNotice"/,
               "iOS handler must emit the eviction-notice event when JS is listening");
});

// ── Android receiver shape ───────────────────────────────────────────

test("Android bridge declares the offline-eviction Wearable path constant", () => {
  const droid = extractAndroidTemplate();
  assert.match(droid, /PATH_OFFLINE_EVICTION\s*=\s*"\/kharagolf\/offline-eviction"/,
               "Android must declare the path the watch sends eviction notices on");
});

test("Android bridge registers a MessageClient listener for the eviction path", () => {
  const droid = extractAndroidTemplate();
  // A separate listener (not piggy-backing on the settings listener)
  // because the path differs.
  assert.match(droid, /offlineEvictionListener\s*=\s*MessageClient\.OnMessageReceivedListener/,
               "Android must declare an offlineEvictionListener");
  // The listener must short-circuit on path mismatch — otherwise it'd
  // post a notification for every Wearable message.
  assert.match(droid, /event\.path\s*!=\s*PATH_OFFLINE_EVICTION/,
               "Android listener must guard on the eviction path");
  // And actually be added to the MessageClient so it fires.
  assert.match(droid, /addListener\(offlineEvictionListener\)/,
               "Android listener must be registered on the MessageClient");
});

test("Android bridge parses count + oldestEvictedTimestampMs from JSON payload", () => {
  const droid = extractAndroidTemplate();
  assert.match(droid, /optInt\("count",\s*0\)/,
               "Android listener must parse the count field");
  assert.match(droid, /optLong\("oldestEvictedTimestampMs",\s*0L\)/,
               "Android listener must parse the oldest-eviction timestamp field");
});

test("Android bridge posts a NotificationCompat notification with both fields", () => {
  const droid = extractAndroidTemplate();
  // Wiring: listener calls the notification helper.
  assert.match(droid, /postOfflineEvictionNotification\(count,\s*oldestMs\)/,
               "Android listener must call the notification helper with parsed fields");
  // The helper itself.
  assert.match(droid, /private\s+fun\s+postOfflineEvictionNotification/,
               "Android notification helper must be defined");
  assert.match(droid, /androidx\.core\.app\.NotificationCompat\.Builder/,
               "Android notification helper must use NotificationCompat.Builder");
  // Notification carries the count in the title and the age in the body.
  assert.match(droid, /setContentTitle\("KHARAGOLF watch cleared \$count stale \$plural"\)/,
               "Android notification title must include the count and pluralised noun");
  assert.match(droid, /\$ageDays \$dayWord old/,
               "Android notification body must surface the age of the oldest dropped record");
});

test("Android bridge uses a LOW-importance dedicated channel", () => {
  const droid = extractAndroidTemplate();
  // This is a courtesy heads-up, not an alert — should not buzz the phone.
  assert.match(droid, /EVICTION_CHANNEL_ID\s*=\s*"kharagolf-watch-cleanup"/,
               "Android must declare a dedicated channel id for cleanup notices");
  assert.match(droid, /IMPORTANCE_LOW/,
               "Android channel must be LOW importance");
});

test("Android bridge dedupes notifications by oldest-eviction timestamp", () => {
  const droid = extractAndroidTemplate();
  // The notification id is keyed on the timestamp so a re-delivery
  // coalesces into the same notification.
  assert.match(droid, /"kharagolf\.offline-eviction\.\$oldestEvictedTimestampMs"\.hashCode\(\)/,
               "Android notification id must hash the oldest-eviction timestamp for dedupe");
});

test("Android bridge emits KharagolfWatchEvictionNotice to JS subscribers", () => {
  const droid = extractAndroidTemplate();
  assert.match(droid, /emit\("KharagolfWatchEvictionNotice"/,
               "Android listener must emit the eviction-notice event when JS is listening");
});

// ── Cross-platform contract check ────────────────────────────────────

test("iOS and Android bridges agree on the eviction payload field names", () => {
  // The watch sends {count, oldestEvictedTimestampMs}; both bridges MUST
  // read those exact field names or one platform would silently get an
  // empty notification.
  const ios = extractIOSTemplate();
  const droid = extractAndroidTemplate();
  for (const field of ["count", "oldestEvictedTimestampMs"]) {
    assert.ok(ios.includes(field),
              `iOS bridge must reference payload field "${field}"`);
    assert.ok(droid.includes(field),
              `Android bridge must reference payload field "${field}"`);
  }
});
