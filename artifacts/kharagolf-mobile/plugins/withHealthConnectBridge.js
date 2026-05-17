/**
 * Expo Config Plugin — KharagolfHealthConnect Native Module
 *
 * Android-only mirror of `withHealthKitBridge`. Wires Google's Health Connect
 * SDK into the app so Android players without Whoop or Garmin can still feed
 * sleep / HRV / RHR / step totals into the wellness store. iOS is left alone
 * — that platform is covered by HealthKit.
 *
 * What this plugin does at prebuild time:
 *   1. Adds the four Health Connect READ permissions plus the Health Connect
 *      package <queries> entry to AndroidManifest.xml. Also adds the
 *      `androidx.health.ACTION_SHOW_PERMISSIONS_RATIONALE` intent-filter to
 *      MainActivity so Health Connect can deep-link into the app for the
 *      privacy rationale (required by Google Play review on production).
 *   2. Drops `androidx.health.connect:connect-client` into
 *      `app/build.gradle` if it isn't already there.
 *   3. Writes `KharagolfHealthConnectModule.kt` and the matching ReactPackage
 *      into the application Java/Kotlin source tree, then registers the
 *      package in `MainApplication.kt`.
 *
 * The native module exposes three React Native methods, mirroring the iOS
 * HealthKit bridge so the JS wrapper can switch on `Platform.OS` without
 * branching on shape:
 *
 *   isAvailable() -> Promise<boolean>
 *   requestAuthorization() -> Promise<boolean>
 *   readLast7Days() -> Promise<Array<{
 *     date: string,            // YYYY-MM-DD (device local time)
 *     sleepMinutes: number?,
 *     hrvMs: number?,          // average RMSSD over the day
 *     restingHr: number?,      // most recent resting HR sample for the day
 *     steps: number?
 *   }>>
 */

const { withDangerousMod, withAndroidManifest } = require("@expo/config-plugins");
const path = require("path");
const fs = require("fs");

const HEALTH_CONNECT_PERMISSIONS = [
  "android.permission.health.READ_SLEEP",
  "android.permission.health.READ_HEART_RATE_VARIABILITY",
  "android.permission.health.READ_RESTING_HEART_RATE",
  "android.permission.health.READ_STEPS",
];

const ANDROID_BRIDGE_IMPL = `
package com.kharagolf.mobile

import android.content.Intent
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.PermissionController
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.HeartRateVariabilityRmssdRecord
import androidx.health.connect.client.records.RestingHeartRateRecord
import androidx.health.connect.client.records.SleepSessionRecord
import androidx.health.connect.client.records.StepsRecord
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import com.facebook.react.bridge.ActivityEventListener
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.BaseActivityEventListener
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableArray
import com.facebook.react.bridge.WritableMap
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.util.Date
import java.util.Locale
import java.util.TimeZone

class KharagolfHealthConnectModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName() = "KharagolfHealthConnect"

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private val readPermissions = setOf(
        HealthPermission.getReadPermission(SleepSessionRecord::class),
        HealthPermission.getReadPermission(HeartRateVariabilityRmssdRecord::class),
        HealthPermission.getReadPermission(RestingHeartRateRecord::class),
        HealthPermission.getReadPermission(StepsRecord::class),
    )

    @Volatile private var pendingAuthPromise: Promise? = null

    init {
        reactContext.addActivityEventListener(object : BaseActivityEventListener() {
            override fun onActivityResult(activity: android.app.Activity?, requestCode: Int, resultCode: Int, data: Intent?) {
                if (requestCode != REQUEST_CODE_PERMS) return
                val promise = pendingAuthPromise ?: return
                pendingAuthPromise = null
                try {
                    val contract = PermissionController.createRequestPermissionResultContract()
                    val granted = contract.parseResult(resultCode, data)
                    promise.resolve(granted.containsAll(readPermissions))
                } catch (t: Throwable) {
                    promise.resolve(false)
                }
            }
        } as ActivityEventListener)
    }

    private fun sdkAvailable(): Boolean = try {
        HealthConnectClient.getSdkStatus(reactApplicationContext) == HealthConnectClient.SDK_AVAILABLE
    } catch (_: Throwable) { false }

    private fun client(): HealthConnectClient? = try {
        if (sdkAvailable()) HealthConnectClient.getOrCreate(reactApplicationContext) else null
    } catch (_: Throwable) { null }

    @ReactMethod
    fun isAvailable(promise: Promise) {
        promise.resolve(sdkAvailable())
    }

    @ReactMethod
    fun requestAuthorization(promise: Promise) {
        val hc = client()
        if (hc == null) { promise.resolve(false); return }
        scope.launch {
            try {
                val granted = hc.permissionController.getGrantedPermissions()
                if (granted.containsAll(readPermissions)) {
                    promise.resolve(true)
                    return@launch
                }
                val activity = currentActivity
                if (activity == null) {
                    // Without a foreground activity the system permission sheet
                    // cannot be shown. Resolve falsy so the caller can retry on
                    // the next foreground tick.
                    promise.resolve(false)
                    return@launch
                }
                val contract = PermissionController.createRequestPermissionResultContract()
                val intent = contract.createIntent(activity, readPermissions)
                pendingAuthPromise = promise
                activity.startActivityForResult(intent, REQUEST_CODE_PERMS)
            } catch (t: Throwable) {
                pendingAuthPromise = null
                promise.resolve(false)
            }
        }
    }

    @ReactMethod
    fun readLast7Days(promise: Promise) {
        val hc = client()
        if (hc == null) { promise.resolve(Arguments.createArray()); return }
        scope.launch {
            try {
                val zone = ZoneId.systemDefault()
                val today = LocalDate.now(zone)
                val earliestDay = today.minusDays(6)
                val start = earliestDay.atStartOfDay(zone).toInstant()
                val end = today.plusDays(1).atStartOfDay(zone).toInstant()
                val isoFmt = SimpleDateFormat("yyyy-MM-dd", Locale.US).apply {
                    timeZone = TimeZone.getTimeZone(zone)
                }

                // Initialise day buckets so missing metrics surface as null
                // rather than dropping the day entirely — same shape the JS
                // wrapper already expects from the iOS bridge.
                val keys: List<String> = (0..6).map { isoFmt.format(Date.from(earliestDay.plusDays(it.toLong()).atStartOfDay(zone).toInstant())) }
                val buckets: MutableMap<String, MutableMap<String, Any?>> = LinkedHashMap()
                for (k in keys) buckets[k] = mutableMapOf("date" to k, "sleepMinutes" to null, "hrvMs" to null, "restingHr" to null, "steps" to null)

                val filter = TimeRangeFilter.between(start, end)

                fun bucketKey(t: Instant): String? {
                    val key = isoFmt.format(Date.from(t))
                    return if (buckets.containsKey(key)) key else null
                }

                // ── Sleep (sum of asleep minutes per local day, bucketed by
                //    session END so an overnight sleep counts toward the day
                //    you wake up — same convention as Apple Health) ─────────
                runCatching {
                    val resp = hc.readRecords(ReadRecordsRequest(SleepSessionRecord::class, filter))
                    val totals = HashMap<String, Long>()
                    for (s in resp.records) {
                        val key = bucketKey(s.endTime) ?: continue
                        val mins = (s.endTime.toEpochMilli() - s.startTime.toEpochMilli()) / 60000L
                        totals[key] = (totals[key] ?: 0L) + mins
                    }
                    for ((k, v) in totals) buckets[k]?.put("sleepMinutes", v.toInt())
                }

                // ── HRV (average RMSSD ms per day) ───────────────────────────
                runCatching {
                    val resp = hc.readRecords(ReadRecordsRequest(HeartRateVariabilityRmssdRecord::class, filter))
                    val sums = HashMap<String, Double>()
                    val counts = HashMap<String, Int>()
                    for (r in resp.records) {
                        val key = bucketKey(r.time) ?: continue
                        sums[key] = (sums[key] ?: 0.0) + r.heartRateVariabilityMillis
                        counts[key] = (counts[key] ?: 0) + 1
                    }
                    for ((k, sum) in sums) {
                        val n = counts[k] ?: 0
                        if (n > 0) buckets[k]?.put("hrvMs", sum / n)
                    }
                }

                // ── Resting Heart Rate (latest sample of each day) ──────────
                runCatching {
                    val resp = hc.readRecords(ReadRecordsRequest(RestingHeartRateRecord::class, filter))
                    val latest = HashMap<String, Pair<Instant, Long>>()
                    for (r in resp.records) {
                        val key = bucketKey(r.time) ?: continue
                        val prev = latest[key]
                        if (prev == null || r.time.isAfter(prev.first)) {
                            latest[key] = r.time to r.beatsPerMinute
                        }
                    }
                    for ((k, v) in latest) buckets[k]?.put("restingHr", v.second.toInt())
                }

                // ── Steps (sum per day) ─────────────────────────────────────
                runCatching {
                    val resp = hc.readRecords(ReadRecordsRequest(StepsRecord::class, filter))
                    val totals = HashMap<String, Long>()
                    for (r in resp.records) {
                        // Bucket by the START of the steps window — Health
                        // Connect splits long walks across the day boundary so
                        // either side is fine; start matches Apple's bucketing.
                        val key = bucketKey(r.startTime) ?: continue
                        totals[key] = (totals[key] ?: 0L) + r.count
                    }
                    for ((k, v) in totals) buckets[k]?.put("steps", v.toInt())
                }

                val out: WritableArray = Arguments.createArray()
                for (k in keys) {
                    val map: WritableMap = Arguments.createMap()
                    val b = buckets[k]!!
                    map.putString("date", b["date"] as String)
                    when (val v = b["sleepMinutes"]) { is Int -> map.putInt("sleepMinutes", v); else -> map.putNull("sleepMinutes") }
                    when (val v = b["hrvMs"]) { is Double -> map.putDouble("hrvMs", v); else -> map.putNull("hrvMs") }
                    when (val v = b["restingHr"]) { is Int -> map.putInt("restingHr", v); else -> map.putNull("restingHr") }
                    when (val v = b["steps"]) { is Int -> map.putInt("steps", v); else -> map.putNull("steps") }
                    out.pushMap(map)
                }
                promise.resolve(out)
            } catch (t: Throwable) {
                promise.reject("HEALTH_CONNECT_READ", t.message, t)
            }
        }
    }

    companion object {
        private const val REQUEST_CODE_PERMS = 0x4843 // 'HC'
    }
}
`.trim();

const ANDROID_PACKAGE_IMPL = `
package com.kharagolf.mobile

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

class KharagolfHealthConnectPackage : ReactPackage {
    override fun createNativeModules(ctx: ReactApplicationContext): List<NativeModule> =
        listOf(KharagolfHealthConnectModule(ctx))
    override fun createViewManagers(ctx: ReactApplicationContext): List<ViewManager<*, *>> =
        emptyList()
}
`.trim();

// ── Manifest patch ────────────────────────────────────────────────────────────

const withHealthConnectManifest = (config) => {
  return withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults.manifest;

    // Permissions
    manifest["uses-permission"] = manifest["uses-permission"] || [];
    for (const perm of HEALTH_CONNECT_PERMISSIONS) {
      const exists = manifest["uses-permission"].some(
        (p) => p.$ && p.$["android:name"] === perm,
      );
      if (!exists) {
        manifest["uses-permission"].push({ $: { "android:name": perm } });
      }
    }

    // <queries> entry so the app can detect / launch Health Connect on Android
    // 13 and below, where Health Connect ships as a separate APK.
    manifest.queries = manifest.queries || [];
    const hcPkg = "com.google.android.apps.healthdata";
    const hasQuery = manifest.queries.some(
      (q) => Array.isArray(q.package) && q.package.some((p) => p.$ && p.$["android:name"] === hcPkg),
    );
    if (!hasQuery) {
      manifest.queries.push({ package: [{ $: { "android:name": hcPkg } }] });
    }

    // Permission rationale intent-filter on MainActivity (Google Play review
    // requirement). Adds an additional <intent-filter> alongside the existing
    // launcher intent — does not replace it.
    const application = manifest.application?.[0];
    const mainActivity = application?.activity?.find(
      (a) => a.$ && a.$["android:name"] === ".MainActivity",
    );
    if (mainActivity) {
      mainActivity["intent-filter"] = mainActivity["intent-filter"] || [];
      const RATIONALE_ACTION = "androidx.health.ACTION_SHOW_PERMISSIONS_RATIONALE";
      const hasRationale = mainActivity["intent-filter"].some((f) =>
        Array.isArray(f.action) && f.action.some((a) => a.$ && a.$["android:name"] === RATIONALE_ACTION),
      );
      if (!hasRationale) {
        mainActivity["intent-filter"].push({
          action: [{ $: { "android:name": RATIONALE_ACTION } }],
        });
      }
    }

    return cfg;
  });
};

// ── Native sources + gradle dep + MainApplication wiring ──────────────────────

const withHealthConnectAndroid = (config) => {
  return withDangerousMod(config, ["android", (mod) => {
    const platformRoot = mod.modRequest.platformProjectRoot;
    const androidPackage = mod.android?.package ?? config.android?.package ?? "com.kharagolf.mobile";
    const packagePath = androidPackage.replace(/\./g, path.sep);
    const javaDir = path.join(platformRoot, "app", "src", "main", "java", packagePath);
    fs.mkdirSync(javaDir, { recursive: true });

    const patchPkg = (src) => src.replace(/^package com\.kharagolf\.mobile$/m, `package ${androidPackage}`);
    fs.writeFileSync(path.join(javaDir, "KharagolfHealthConnectModule.kt"), patchPkg(ANDROID_BRIDGE_IMPL) + "\n");
    fs.writeFileSync(path.join(javaDir, "KharagolfHealthConnectPackage.kt"), patchPkg(ANDROID_PACKAGE_IMPL) + "\n");

    // Register the package with MainApplication.kt — same approach as the
    // watch bridge so the two stay structurally consistent.
    const mainAppPath = path.join(javaDir, "MainApplication.kt");
    if (!fs.existsSync(mainAppPath)) {
      throw new Error(
        `withHealthConnectBridge: MainApplication.kt not found at ${mainAppPath}. ` +
        "Run expo prebuild before running this plugin.",
      );
    }
    let mainApp = fs.readFileSync(mainAppPath, "utf8");
    if (!mainApp.includes("KharagolfHealthConnectPackage")) {
      mainApp = mainApp.replace(
        /^(import (?!com\.kharagolf\.mobile\.KharagolfHealthConnect).+\n)(\n?class MainApplication)/m,
        `$1import ${androidPackage}.KharagolfHealthConnectPackage\n$2`,
      );
      mainApp = mainApp.replace(
        /(val packages = PackageList\(this\)\.packages)/,
        "$1\n        packages.add(KharagolfHealthConnectPackage())",
      );
      if (!mainApp.includes("KharagolfHealthConnectPackage()")) {
        mainApp = mainApp.replace(
          /PackageList\(this\)\.packages/,
          "PackageList(this).packages.also { it.add(KharagolfHealthConnectPackage()) }",
        );
      }
      if (!mainApp.includes("KharagolfHealthConnectPackage()")) {
        throw new Error(
          "withHealthConnectBridge: failed to inject KharagolfHealthConnectPackage into MainApplication.kt.",
        );
      }
      fs.writeFileSync(mainAppPath, mainApp);
    }

    // Gradle dependency
    const appBuildGradlePath = path.join(platformRoot, "app", "build.gradle");
    if (fs.existsSync(appBuildGradlePath)) {
      let buildGradle = fs.readFileSync(appBuildGradlePath, "utf8");
      if (!buildGradle.includes("androidx.health.connect:connect-client")) {
        buildGradle = buildGradle.replace(
          /dependencies\s*\{/,
          'dependencies {\n    implementation "androidx.health.connect:connect-client:1.1.0-alpha07"',
        );
        fs.writeFileSync(appBuildGradlePath, buildGradle);
      }
    }

    return mod;
  }]);
};

module.exports = (config) => {
  config = withHealthConnectManifest(config);
  config = withHealthConnectAndroid(config);
  return config;
};
