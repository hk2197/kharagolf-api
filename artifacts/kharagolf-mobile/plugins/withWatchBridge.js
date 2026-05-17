/**
 * Expo Config Plugin — KharagolfWatchBridge Native Module
 * Injects iOS (WCSession) and Android (Wearable Data Layer) bridge sources during prebuild.
 */

const { withDangerousMod, withAndroidManifest, withXcodeProject } = require("@expo/config-plugins");
const path = require("path");
const fs   = require("fs");

// ── iOS ───────────────────────────────────────────────────────────────────────

const IOS_BRIDGE_HEADER = `
#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>
@interface KharagolfWatchBridgeModule : RCTEventEmitter <RCTBridgeModule>
@end
`.trim();

const IOS_BRIDGE_IMPL = `
import Foundation
import WatchConnectivity
import UserNotifications
import React

@objc(KharagolfWatchBridgeModule)
class KharagolfWatchBridgeModule: RCTEventEmitter, WCSessionDelegate {
  override static func moduleName() -> String! { "KharagolfWatchBridge" }
  override static func requiresMainQueueSetup() -> Bool { false }

  // Events emitted to JS via NativeEventEmitter. Currently used for the
  // watch → phone battery auto-enable threshold sync (Task #671) so the
  // phone-side Watch Settings modal updates the moment the player nudges
  // the threshold from the watch.
  override func supportedEvents() -> [String]! {
    return ["KharagolfWatchSettingsChanged", "KharagolfWatchEvictionNotice"]
  }

  // Track JS-side listener count so we don't waste cycles emitting events
  // when nothing is subscribed.
  private var hasJSListeners = false
  override func startObserving() { hasJSListeners = true }
  override func stopObserving()  { hasJSListeners = false }

  private let session = WCSession.default

  // Task #431 — HR sample forwarding state. Set by hrStart() so the WCSession
  // delegate can POST inbound watch HR batches to /api/portal/hr-samples.
  private var hrAuthToken: String?
  private var hrBaseURL: String?

  override init() {
    super.init()
    if WCSession.isSupported() {
      session.delegate = self
      session.activate()
    }
  }

  // MARK: — WCSessionDelegate
  func session(_ session: WCSession, activationDidCompleteWith state: WCSessionActivationState, error: Error?) {}
  func sessionDidBecomeInactive(_ session: WCSession) {}
  func sessionDidDeactivate(_ session: WCSession) { session.activate() }

  // Task #431 — incoming "hr.samples" batches from the watch get forwarded
  // to the server. Same handler covers application-context fallback so
  // samples queued while the phone was unreachable are not lost.
  func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
    handleIncoming(message)
  }
  func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
    handleIncoming(applicationContext)
  }

  private func handleIncoming(_ payload: [String: Any]) {
    if let samples = payload["samples"] as? [[String: Any]],
       (payload["type"] as? String) == "hr.samples" {
      forwardHrSamples(samples)
    } else if let pending = payload["pendingHrSamples"] as? [[String: Any]] {
      forwardHrSamples(pending)
    }
    // Task #671 — watch → phone battery auto-enable threshold sync.
    // Persist into App Group so the next launch reflects the watch-set
    // value even if JS isn't running yet, and emit an event so the open
    // Watch Settings modal updates immediately.
    if let s = payload["watchSettingsFromWatch"] as? [String: Any] {
      if let raw = s["batteryAutoThreshold"] as? Double {
        let clamped = max(0.05, min(0.95, raw))
        if let group = UserDefaults(suiteName: "group.com.kharagolf.shared") {
          group.set(Float(clamped), forKey: "kharagolf_battery_auto_threshold")
          group.set(Int(Date().timeIntervalSince1970 * 1000),
                    forKey: "kharagolf_battery_auto_threshold_from_watch_ts")
        }
        if hasJSListeners {
          sendEvent(withName: "KharagolfWatchSettingsChanged",
                    body: ["batteryAutoThreshold": clamped])
        }
      }
    }
    // Task #1979 — watch → phone offline-queue eviction notice. The watch
    // surfaces a local banner when stale offline scores are dropped; we
    // mirror it as a paired phone local notification so the player sees
    // the cleanup summary on whichever device they pick up first.
    // Payload: { count: Int, oldestEvictedTimestampMs: Int64 }.
    if let evict = payload["watchOfflineEviction"] as? [String: Any] {
      let count = (evict["count"] as? Int) ?? (evict["count"] as? NSNumber)?.intValue ?? 0
      let oldestMs = (evict["oldestEvictedTimestampMs"] as? Int64)
                     ?? (evict["oldestEvictedTimestampMs"] as? NSNumber)?.int64Value
                     ?? 0
      if count > 0 && oldestMs > 0 {
        postOfflineEvictionNotification(count: count, oldestEvictedTimestampMs: oldestMs)
        if hasJSListeners {
          sendEvent(withName: "KharagolfWatchEvictionNotice",
                    body: ["count": count,
                           "oldestEvictedTimestampMs": NSNumber(value: oldestMs)])
        }
      }
    }
  }

  /// Task #1979 — Schedule a UNUserNotificationCenter local notification
  /// summarising what the watch trimmed from its offline queue. Best-effort:
  /// we only post if the user has already authorised notifications (don't
  /// pester them on first run) and the notification carries no sound — this
  /// is a courtesy heads-up, not an alert. The identifier is keyed on the
  /// oldest-dropped timestamp so a re-delivery of the same payload (e.g.
  /// the watch retrying over WCSession application context) coalesces into
  /// the same notification instead of stacking duplicates.
  private func postOfflineEvictionNotification(count: Int, oldestEvictedTimestampMs: Int64) {
    let center = UNUserNotificationCenter.current()
    center.getNotificationSettings { settings in
      guard settings.authorizationStatus == .authorized
            || settings.authorizationStatus == .provisional else { return }
      let content = UNMutableNotificationContent()
      let plural  = count == 1 ? "score" : "scores"
      let oldestSec = TimeInterval(oldestEvictedTimestampMs) / 1000.0
      let ageDays = max(1, Int((Date().timeIntervalSince1970 - oldestSec) / 86_400.0))
      let dayWord = ageDays == 1 ? "day" : "days"
      content.title = "KHARAGOLF watch cleared \\(count) stale \\(plural)"
      content.body  = "Oldest was about \\(ageDays) \\(dayWord) old. These were never synced and have been removed from the watch queue."
      content.sound = nil
      let id = "kharagolf.offline-eviction.\\(oldestEvictedTimestampMs)"
      let req = UNNotificationRequest(identifier: id, content: content, trigger: nil)
      center.add(req, withCompletionHandler: nil)
    }
  }

  private func forwardHrSamples(_ samples: [[String: Any]]) {
    guard let token = hrAuthToken,
          let base  = hrBaseURL,
          !samples.isEmpty,
          let url = URL(string: "\\(base)/api/portal/hr-samples") else { return }
    var req = URLRequest(url: url)
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.setValue("Bearer \\(token)", forHTTPHeaderField: "Authorization")
    req.timeoutInterval = 15
    let body: [String: Any] = ["samples": samples]
    req.httpBody = try? JSONSerialization.data(withJSONObject: body)
    URLSession.shared.dataTask(with: req) { _, _, err in
      if let err = err { NSLog("[HR] forward error: \\(err)") }
    }.resume()
  }

  // MARK: — Task #431 HR control surface

  @objc func hrStart(_ authToken: String,
                       baseURL: String,
                       context: NSDictionary,
                       resolver resolve: @escaping RCTPromiseResolveBlock,
                       rejecter reject: @escaping RCTPromiseRejectBlock) {
    hrAuthToken = authToken
    hrBaseURL = baseURL
    // Task #874 — open the server-side active-HR-session marker so the
    // ingest endpoint will accept incoming sample batches. Done here in
    // the native bridge (not just from the JS score-screen useEffect)
    // so any caller that drives hrStart on its own — e.g. a watch
    // reconnect or phone-wake path — also keeps the server marker in
    // sync. Fire-and-forget; ingest is gated by the marker, so a
    // dropped session POST just delays the first batch.
    postHrSessionMarker(action: "start")
    deliver(["type": "hr.start", "context": context], resolve: resolve, reject: reject)
  }

  @objc func hrStop(_ resolve: @escaping RCTPromiseResolveBlock,
                      rejecter reject: @escaping RCTPromiseRejectBlock) {
    // Task #874 — close the server-side session marker before we drop
    // the auth token, so any straggling sample POSTs the watch sends
    // after we tell it to stop are refused with session_inactive
    // instead of being silently accepted. Capture the token/base URL
    // first because we clear them immediately below.
    postHrSessionMarker(action: "end")
    // Clear forwarding state immediately so a stop request always halts
    // server forwarding even if the watch is currently unreachable and the
    // outbound "hr.stop" message can't be delivered.
    hrAuthToken = nil
    hrBaseURL = nil
    deliver(["type": "hr.stop"], resolve: resolve, reject: reject)
  }

  /// Task #874 — POST /api/portal/hr-samples/session with the given action
  /// using the currently-stashed auth token + base URL. No-op when either
  /// is missing (caller invoked hrStop without ever calling hrStart, or a
  /// race cleared the token between calls). Errors are logged but never
  /// surfaced to JS — the marker is best-effort and the ingest endpoint
  /// already enforces it on the server side.
  ///
  /// Task #1186 — The request is captured up front and the retry helper
  /// reuses it, so an "end" marker still gets retried even after hrStop
  /// has cleared hrAuthToken/hrBaseURL on the instance.
  private func postHrSessionMarker(action: String) {
    guard let token = hrAuthToken,
          let base  = hrBaseURL,
          let url   = URL(string: "\\(base)/api/portal/hr-samples/session") else { return }
    var req = URLRequest(url: url)
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.setValue("Bearer \\(token)", forHTTPHeaderField: "Authorization")
    req.timeoutInterval = 10
    req.httpBody = try? JSONSerialization.data(withJSONObject: ["action": action])
    attemptHrSessionMarker(req, action: action, attempt: 0)
  }

  /// Task #1186 — Retry the session-marker POST a couple of times with
  /// short backoff (~500ms, ~1500ms) so a transient network blip — e.g.
  /// the user mid-handoff between WiFi and cellular at exactly the
  /// moment hrStart fires — doesn't leave the server-side marker closed
  /// and silently stall every subsequent sample batch with
  /// session_inactive. Only retries on transport errors and 5xx/408/429
  /// responses; 4xx (auth, validation) won't get better by retrying.
  private func attemptHrSessionMarker(_ req: URLRequest, action: String, attempt: Int) {
    let maxAttempts = 3
    URLSession.shared.dataTask(with: req) { _, resp, err in
      let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
      if err == nil && status >= 200 && status < 300 { return }
      let transient = err != nil || status == 0 || status >= 500 || status == 408 || status == 429
      let nextAttempt = attempt + 1
      if transient && nextAttempt < maxAttempts {
        let delay: TimeInterval = attempt == 0 ? 0.5 : 1.5
        DispatchQueue.global().asyncAfter(deadline: .now() + delay) { [weak self] in
          self?.attemptHrSessionMarker(req, action: action, attempt: nextAttempt)
        }
      } else {
        if let err = err {
          NSLog("[HR] session \\(action) gave up after \\(nextAttempt) attempts: \\(err)")
        } else {
          NSLog("[HR] session \\(action) gave up after \\(nextAttempt) attempts: HTTP \\(status)")
        }
      }
    }.resume()
  }

  @objc func hrPushContext(_ context: NSDictionary,
                             resolver resolve: @escaping RCTPromiseResolveBlock,
                             rejecter reject: @escaping RCTPromiseRejectBlock) {
    deliver(["type": "hr.context", "context": context], resolve: resolve, reject: reject)
  }

  // MARK: — Delivery helpers

  private func deliver(_ payload: [String: Any],
                       resolve: @escaping RCTPromiseResolveBlock,
                       reject: @escaping RCTPromiseRejectBlock) {
    guard WCSession.isSupported(), session.isPaired, session.isWatchAppInstalled else {
      reject("WATCH_UNAVAILABLE", "No paired Apple Watch with KHARAGOLF app installed", nil)
      return
    }
    let send: () -> Void = {
      do {
        try self.session.updateApplicationContext(payload)
        resolve(nil)
      } catch {
        reject("WCSESSION_ERROR", error.localizedDescription, error as NSError)
      }
    }
    if session.isReachable {
      session.sendMessage(payload, replyHandler: nil) { _ in send() }
    } else {
      send()
    }
  }

  @objc func pushToken(_ token: String,
                        resolver resolve: @escaping RCTPromiseResolveBlock,
                        rejecter reject: @escaping RCTPromiseRejectBlock) {
    deliver(["watchToken": token], resolve: resolve, reject: reject)
  }

  @objc func pushChallenge(_ code: String,
                             challengeId: String,
                             resolver resolve: @escaping RCTPromiseResolveBlock,
                             rejecter reject: @escaping RCTPromiseRejectBlock) {
    deliver(["watchPairingCode": code, "watchChallengeId": challengeId], resolve: resolve, reject: reject)
  }

  @objc func pushHoleContext(_ tournamentId: NSNumber,
                               playerId: NSNumber,
                               round: NSNumber,
                               holeNumber: NSNumber,
                               par: NSNumber,
                               resolver resolve: @escaping RCTPromiseResolveBlock,
                               rejecter reject: @escaping RCTPromiseRejectBlock) {
    deliver([
      "watchHoleContext": [
        "tournamentId": tournamentId.intValue,
        "playerId":     playerId.intValue,
        "round":        round.intValue,
        "holeNumber":   holeNumber.intValue,
        "par":          par.intValue,
      ]
    ], resolve: resolve, reject: reject)
  }

  @objc func pushPlaysLike(_ holeNumber: NSNumber,
                             rawYards: NSNumber,
                             playsLikeYards: NSNumber,
                             windAdj: NSNumber,
                             elevAdj: NSNumber,
                             resolver resolve: @escaping RCTPromiseResolveBlock,
                             rejecter reject: @escaping RCTPromiseRejectBlock) {
    deliver([
      "watchPlaysLike": [
        "holeNumber":     holeNumber.intValue,
        "rawYards":       rawYards.intValue,
        "playsLikeYards": playsLikeYards.intValue,
        "windAdj":        windAdj.intValue,
        "elevAdj":        elevAdj.intValue,
      ]
    ], resolve: resolve, reject: reject)
  }

  // Mirrors mobile-app preferences (battery saver + feature toggles) into the
  // watch app via App Group UserDefaults, where the watch extension reads them
  // synchronously without blocking on a Wearable Data Layer round-trip.
  @objc func pushSettings(_ batteryMode: ObjCBool,
                            hapticTargetingEnabled: ObjCBool,
                            voiceEntryEnabled: ObjCBool,
                            batteryAutoThreshold: NSNumber,
                            resolver resolve: @escaping RCTPromiseResolveBlock,
                            rejecter reject: @escaping RCTPromiseRejectBlock) {
    let threshold = max(0.05, min(0.95, batteryAutoThreshold.floatValue))
    if let group = UserDefaults(suiteName: "group.com.kharagolf.shared") {
      group.set(batteryMode.boolValue, forKey: "kharagolf_watch_battery_mode")
      group.set(hapticTargetingEnabled.boolValue, forKey: "kharagolf_watch_haptic_targeting")
      group.set(voiceEntryEnabled.boolValue, forKey: "kharagolf_watch_voice_entry")
      group.set(threshold, forKey: "kharagolf_battery_auto_threshold")
    }
    deliver([
      "watchSettings": [
        "batteryMode":            batteryMode.boolValue,
        "hapticTargetingEnabled": hapticTargetingEnabled.boolValue,
        "voiceEntryEnabled":      voiceEntryEnabled.boolValue,
        "batteryAutoThreshold":   threshold,
      ]
    ], resolve: resolve, reject: reject)
  }
}
`.trim();

// ── Android ───────────────────────────────────────────────────────────────────

const ANDROID_BRIDGE_IMPL = `
package com.kharagolf.mobile

import android.content.Context
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.google.android.gms.wearable.DataClient
import com.google.android.gms.wearable.DataEventBuffer
import com.google.android.gms.wearable.DataMapItem
import com.google.android.gms.wearable.MessageClient
import com.google.android.gms.wearable.PutDataMapRequest
import com.google.android.gms.wearable.Wearable
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

private const val SETTINGS_PREF_FILE = "kharagolf_watch_phone"
private const val PATH_SETTINGS_FROM_WATCH = "/kharagolf/settings-from-watch"
// Task #1979 — watch → phone offline-queue eviction notice path. The watch
// posts a one-shot summary here when stale offline scores were dropped so
// the phone can mirror the watch banner as a paired local notification.
private const val PATH_OFFLINE_EVICTION = "/kharagolf/offline-eviction"
private const val EVICTION_CHANNEL_ID = "kharagolf-watch-cleanup"

class KharagolfWatchBridgeModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName() = "KharagolfWatchBridge"

    private val scope = CoroutineScope(Dispatchers.IO)

    // Task #431 — HR sample forwarding state. hrStart() stashes these and
    // registers the DataClient listener; hrStop() clears them and unregisters.
    @Volatile private var hrAuthToken: String? = null
    @Volatile private var hrBaseURL: String? = null
    private var hrListener: DataClient.OnDataChangedListener? = null

    // Task #671 — listen for the watch → phone battery auto-enable threshold
    // sync. Persists into SharedPreferences (so a watch reinstall can pull
    // the player's chosen value back from the phone) and emits an event to
    // JS so the Watch Settings modal updates immediately.
    private val settingsFromWatchListener = MessageClient.OnMessageReceivedListener { event ->
        if (event.path != PATH_SETTINGS_FROM_WATCH) return@OnMessageReceivedListener
        try {
            val obj = JSONObject(String(event.data, Charsets.UTF_8))
            if (obj.has("batteryAutoThreshold")) {
                val raw = obj.getDouble("batteryAutoThreshold").coerceIn(0.05, 0.95)
                reactContext.getSharedPreferences(SETTINGS_PREF_FILE, Context.MODE_PRIVATE)
                    .edit()
                    .putFloat("kharagolf_battery_auto_threshold", raw.toFloat())
                    .putLong("kharagolf_battery_auto_threshold_from_watch_ts",
                             System.currentTimeMillis())
                    .apply()
                if (reactContext.hasActiveCatalystInstance()) {
                    val params = com.facebook.react.bridge.Arguments.createMap().apply {
                        putDouble("batteryAutoThreshold", raw)
                    }
                    reactContext
                        .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                        .emit("KharagolfWatchSettingsChanged", params)
                }
            }
        } catch (_: Throwable) { /* malformed payload — drop silently */ }
    }

    // Task #1979 — listen for the watch → phone offline-queue eviction
    // notice. The watch surfaces a one-shot banner when stale offline
    // scores are dropped; we mirror it as a paired phone local
    // notification so the player sees the cleanup summary on whichever
    // device they pick up first. Best-effort: malformed payloads and
    // empty / negative counts are dropped silently.
    private val offlineEvictionListener = MessageClient.OnMessageReceivedListener { event ->
        if (event.path != PATH_OFFLINE_EVICTION) return@OnMessageReceivedListener
        try {
            val obj = JSONObject(String(event.data, Charsets.UTF_8))
            val count = obj.optInt("count", 0)
            val oldestMs = obj.optLong("oldestEvictedTimestampMs", 0L)
            if (count > 0 && oldestMs > 0L) {
                postOfflineEvictionNotification(count, oldestMs)
                if (reactContext.hasActiveCatalystInstance()) {
                    val params = com.facebook.react.bridge.Arguments.createMap().apply {
                        putInt("count", count)
                        putDouble("oldestEvictedTimestampMs", oldestMs.toDouble())
                    }
                    reactContext
                        .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                        .emit("KharagolfWatchEvictionNotice", params)
                }
            }
        } catch (_: Throwable) { /* malformed payload — drop silently */ }
    }

    init {
        // Register the watch → phone settings listener for the lifetime of
        // the module. The Wearable MessageClient holds a weak reference to
        // the listener, so leaks during dev reloads are not a concern.
        try {
            Wearable.getMessageClient(reactContext).addListener(settingsFromWatchListener)
            Wearable.getMessageClient(reactContext).addListener(offlineEvictionListener)
        } catch (_: Throwable) { /* Wearable unavailable on emulator */ }
    }

    /// Task #1979 — Post a NotificationManager local notification
    /// summarising what the watch trimmed from its offline queue. Uses a
    /// LOW-importance channel — this is a courtesy heads-up, not an alert,
    /// and shouldn't make the phone buzz. The notification id is keyed on
    /// the oldest-dropped timestamp so a re-delivery of the same payload
    /// (e.g. the watch retrying) coalesces into the same notification
    /// instead of stacking duplicates.
    private fun postOfflineEvictionNotification(count: Int, oldestEvictedTimestampMs: Long) {
        val ctx = reactApplicationContext
        val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE)
                as? android.app.NotificationManager ?: return
        // Create the notification channel on first use (no-op if it
        // already exists). Required on API 26+; harmless to call always.
        if (android.os.Build.VERSION.SDK_INT >= 26) {
            try {
                val channel = android.app.NotificationChannel(
                    EVICTION_CHANNEL_ID,
                    "Watch cleanup notices",
                    android.app.NotificationManager.IMPORTANCE_LOW,
                ).apply {
                    description = "Heads-up when the watch drops stale offline scores."
                    setShowBadge(false)
                }
                nm.createNotificationChannel(channel)
            } catch (_: Throwable) { /* channel creation best-effort */ }
        }
        val plural = if (count == 1) "score" else "scores"
        val ageDays = kotlin.math.max(
            1,
            ((System.currentTimeMillis() - oldestEvictedTimestampMs) / 86_400_000L).toInt(),
        )
        val dayWord = if (ageDays == 1) "day" else "days"
        val builder = androidx.core.app.NotificationCompat.Builder(ctx, EVICTION_CHANNEL_ID)
            .setContentTitle("KHARAGOLF watch cleared $count stale $plural")
            .setContentText(
                "Oldest was about $ageDays $dayWord old. " +
                "These were never synced and have been removed from the watch queue."
            )
            .setSmallIcon(ctx.applicationInfo.icon)
            .setAutoCancel(true)
            .setPriority(androidx.core.app.NotificationCompat.PRIORITY_LOW)
        try {
            nm.notify(
                "kharagolf.offline-eviction.$oldestEvictedTimestampMs".hashCode(),
                builder.build(),
            )
        } catch (_: Throwable) { /* missing POST_NOTIFICATIONS permission on API 33+ */ }
    }

    private fun sendMessageToAllNodes(path: String, bytes: ByteArray, promise: Promise) {
        val ctx = reactApplicationContext
        Wearable.getNodeClient(ctx).connectedNodes
            .addOnSuccessListener { nodes ->
                if (nodes.isEmpty()) { promise.resolve(null); return@addOnSuccessListener }
                val msgClient = Wearable.getMessageClient(ctx)
                var remaining = nodes.size
                for (node in nodes) {
                    msgClient.sendMessage(node.id, path, bytes)
                        .addOnCompleteListener {
                            if (--remaining == 0) promise.resolve(null)
                        }
                }
            }
            .addOnFailureListener { promise.reject("WEARABLE_ERROR", it.message) }
    }

    private fun contextToJsonBytes(context: ReadableMap?): ByteArray {
        val obj = JSONObject()
        if (context != null) {
            val it = context.entryIterator
            while (it.hasNext()) {
                val (k, v) = it.next()
                if (v != null) obj.put(k, v)
            }
        }
        return obj.toString().toByteArray(Charsets.UTF_8)
    }

    @ReactMethod
    fun hrStart(authToken: String, baseURL: String, context: ReadableMap?, promise: Promise) {
        hrAuthToken = authToken
        hrBaseURL = baseURL
        // Task #874 — open the server-side active-HR-session marker so the
        // ingest endpoint will accept incoming sample batches. Done here in
        // the native bridge (not just from the JS score-screen useEffect)
        // so any caller that drives hrStart on its own — e.g. a watch
        // reconnect or phone-wake path — also keeps the server marker in
        // sync. Fire-and-forget; ingest is gated by the marker, so a
        // dropped session POST just delays the first batch.
        postHrSessionMarker("start")
        // Register a programmatic data listener so /hr/samples DataItems pushed
        // by the wear-os HeartRateSampler get forwarded to the server.
        if (hrListener == null) {
            val l = DataClient.OnDataChangedListener { events: DataEventBuffer ->
                events.forEach { ev ->
                    if (ev.dataItem.uri.path == "/hr/samples") {
                        try {
                            val map = DataMapItem.fromDataItem(ev.dataItem).dataMap
                            val arr = map.getStringArray("samples") ?: return@forEach
                            val samples = JSONArray()
                            for (s in arr) {
                                try { samples.put(JSONObject(s)) } catch (_: Throwable) {}
                            }
                            if (samples.length() > 0) forwardHrSamples(samples)
                        } catch (_: Throwable) { /* drop bad batch */ }
                    }
                }
                events.release()
            }
            Wearable.getDataClient(reactApplicationContext).addListener(l)
            hrListener = l
        }
        sendMessageToAllNodes("/hr/start", contextToJsonBytes(context), promise)
    }

    @ReactMethod
    fun hrStop(promise: Promise) {
        // Task #874 — close the server-side session marker before we drop
        // the auth token, so any straggling sample POSTs the watch sends
        // after we tell it to stop are refused with session_inactive
        // instead of being silently accepted.
        postHrSessionMarker("end")
        hrListener?.let { Wearable.getDataClient(reactApplicationContext).removeListener(it) }
        hrListener = null
        hrAuthToken = null
        hrBaseURL = null
        sendMessageToAllNodes("/hr/stop", ByteArray(0), promise)
    }

    /**
     * Task #874 — POST /api/portal/hr-samples/session with the given action
     * using the currently-stashed auth token + base URL. No-op when either
     * is missing. Errors are swallowed — the marker is best-effort and the
     * ingest endpoint already enforces it on the server side.
     *
     * Task #1186 — Retries the POST up to 3 times with short backoff
     * (~500ms, ~1500ms) so a transient network blip — e.g. the user
     * mid-handoff between WiFi and cellular at exactly the moment hrStart
     * fires — doesn't leave the server-side marker closed and silently
     * stall every subsequent sample batch with session_inactive. The
     * captured token/base are reused for retries, so an "end" marker still
     * gets retried even after hrStop has cleared the instance fields.
     * Only retries on transport errors and 5xx/408/429 responses; 4xx
     * (auth, validation) won't get better by retrying.
     */
    private fun postHrSessionMarker(action: String) {
        val token = hrAuthToken ?: return
        val base = hrBaseURL ?: return
        val maxAttempts = 3
        scope.launch {
            var attempt = 0
            while (attempt < maxAttempts) {
                val transient = try {
                    val url = URL("$base/api/portal/hr-samples/session")
                    val conn = url.openConnection() as HttpURLConnection
                    try {
                        conn.requestMethod = "POST"
                        conn.setRequestProperty("Content-Type", "application/json")
                        conn.setRequestProperty("Authorization", "Bearer $token")
                        conn.connectTimeout = 10000
                        conn.readTimeout = 10000
                        conn.doOutput = true
                        val body = JSONObject().put("action", action).toString()
                        conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
                        val status = conn.responseCode
                        // Drain so the underlying socket can be returned to the pool.
                        try { conn.inputStream.close() } catch (_: Throwable) {
                            try { conn.errorStream?.close() } catch (_: Throwable) {}
                        }
                        if (status in 200..299) return@launch
                        status == 0 || status >= 500 || status == 408 || status == 429
                    } finally {
                        conn.disconnect()
                    }
                } catch (_: Throwable) {
                    true
                }
                attempt++
                if (!transient || attempt >= maxAttempts) {
                    android.util.Log.w(
                        "KharagolfWatchBridge",
                        "HR session $action gave up after $attempt attempt(s)"
                    )
                    return@launch
                }
                delay(if (attempt == 1) 500L else 1500L)
            }
        }
    }

    @ReactMethod
    fun hrPushContext(context: ReadableMap?, promise: Promise) {
        sendMessageToAllNodes("/hr/context", contextToJsonBytes(context), promise)
    }

    private fun forwardHrSamples(samples: JSONArray) {
        val token = hrAuthToken ?: return
        val base = hrBaseURL ?: return
        scope.launch {
            try {
                val url = URL("$base/api/portal/hr-samples")
                val conn = url.openConnection() as HttpURLConnection
                conn.requestMethod = "POST"
                conn.setRequestProperty("Content-Type", "application/json")
                conn.setRequestProperty("Authorization", "Bearer $token")
                conn.connectTimeout = 15000
                conn.readTimeout = 15000
                conn.doOutput = true
                val body = JSONObject().put("samples", samples).toString()
                conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
                conn.inputStream.close()
                conn.disconnect()
            } catch (_: Throwable) { /* network failure — watch will resend on next batch */ }
        }
    }

    @ReactMethod
    fun pushToken(token: String, promise: Promise) {
        scope.launch {
            try {
                val req = PutDataMapRequest.create("/kharagolf/watch-token").apply {
                    dataMap.putString("watchToken", token)
                    dataMap.putLong("timestamp", System.currentTimeMillis())
                }
                Wearable.getDataClient(reactApplicationContext)
                    .putDataItem(req.asPutDataRequest().setUrgent())
                    .addOnSuccessListener { promise.resolve(null) }
                    .addOnFailureListener { promise.reject("WEARABLE_ERROR", it.message) }
            } catch (e: Exception) {
                promise.reject("WEARABLE_ERROR", e.message)
            }
        }
    }

    @ReactMethod
    fun pushChallenge(code: String, challengeId: String, promise: Promise) {
        scope.launch {
            try {
                val req = PutDataMapRequest.create("/kharagolf/challenge").apply {
                    dataMap.putString("watchPairingCode", code)
                    dataMap.putString("watchChallengeId", challengeId)
                    dataMap.putLong("timestamp", System.currentTimeMillis())
                }
                Wearable.getDataClient(reactApplicationContext)
                    .putDataItem(req.asPutDataRequest().setUrgent())
                    .addOnSuccessListener { promise.resolve(null) }
                    .addOnFailureListener { promise.reject("WEARABLE_ERROR", it.message) }
            } catch (e: Exception) {
                promise.reject("WEARABLE_ERROR", e.message)
            }
        }
    }

    @ReactMethod
    fun pushSettings(batteryMode: Boolean, hapticTargetingEnabled: Boolean, voiceEntryEnabled: Boolean, batteryAutoThreshold: Double, promise: Promise) {
        scope.launch {
            try {
                val clamped = batteryAutoThreshold.coerceIn(0.05, 0.95).toFloat()
                val req = PutDataMapRequest.create("/kharagolf/settings").apply {
                    dataMap.putBoolean("batteryMode", batteryMode)
                    dataMap.putBoolean("hapticTargetingEnabled", hapticTargetingEnabled)
                    dataMap.putBoolean("voiceEntryEnabled", voiceEntryEnabled)
                    dataMap.putFloat("batteryAutoThreshold", clamped)
                    dataMap.putLong("timestamp", System.currentTimeMillis())
                }
                Wearable.getDataClient(reactApplicationContext)
                    .putDataItem(req.asPutDataRequest().setUrgent())
                    .addOnSuccessListener { promise.resolve(null) }
                    .addOnFailureListener { promise.reject("WEARABLE_ERROR", it.message) }
            } catch (e: Exception) {
                promise.reject("WEARABLE_ERROR", e.message)
            }
        }
    }

    @ReactMethod
    fun pushHoleContext(tournamentId: Int, playerId: Int, round: Int, holeNumber: Int, par: Int, promise: Promise) {
        scope.launch {
            try {
                val req = PutDataMapRequest.create("/kharagolf/hole-context").apply {
                    dataMap.putInt("tournamentId", tournamentId)
                    dataMap.putInt("playerId",     playerId)
                    dataMap.putInt("round",        round)
                    dataMap.putInt("holeNumber",   holeNumber)
                    dataMap.putInt("par",          par)
                    dataMap.putLong("timestamp",   System.currentTimeMillis())
                }
                Wearable.getDataClient(reactApplicationContext)
                    .putDataItem(req.asPutDataRequest().setUrgent())
                    .addOnSuccessListener { promise.resolve(null) }
                    .addOnFailureListener { promise.reject("WEARABLE_ERROR", it.message) }
            } catch (e: Exception) {
                promise.reject("WEARABLE_ERROR", e.message)
            }
        }
    }

    @ReactMethod
    fun pushPlaysLike(holeNumber: Int, rawYards: Int, playsLikeYards: Int, windAdj: Int, elevAdj: Int, promise: Promise) {
        scope.launch {
            try {
                val req = PutDataMapRequest.create("/kharagolf/plays-like").apply {
                    dataMap.putInt("holeNumber",     holeNumber)
                    dataMap.putInt("rawYards",       rawYards)
                    dataMap.putInt("playsLikeYards", playsLikeYards)
                    dataMap.putInt("windAdj",        windAdj)
                    dataMap.putInt("elevAdj",        elevAdj)
                    dataMap.putLong("timestamp",     System.currentTimeMillis())
                }
                Wearable.getDataClient(reactApplicationContext)
                    .putDataItem(req.asPutDataRequest().setUrgent())
                    .addOnSuccessListener { promise.resolve(null) }
                    .addOnFailureListener { promise.reject("WEARABLE_ERROR", it.message) }
            } catch (e: Exception) {
                promise.reject("WEARABLE_ERROR", e.message)
            }
        }
    }
}
`.trim();

const ANDROID_PACKAGE_IMPL = `
package com.kharagolf.mobile

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

class KharagolfWatchBridgePackage : ReactPackage {
    override fun createNativeModules(ctx: ReactApplicationContext): List<NativeModule> =
        listOf(KharagolfWatchBridgeModule(ctx))
    override fun createViewManagers(ctx: ReactApplicationContext): List<ViewManager<*, *>> =
        emptyList()
}
`.trim();

// ── Plugin ────────────────────────────────────────────────────────────────────

const withWatchBridgeIOS = (config) => {
  return withXcodeProject(config, (mod) => {
    const iosDir      = mod.modRequest.platformProjectRoot;
    const xcodeProject = mod.modResults;
    const projectName  = mod.modRequest.projectName;

    // Write bridge source files into the main app source directory.
    const appSrcDir = path.join(iosDir, projectName);
    fs.mkdirSync(appSrcDir, { recursive: true });

    const bridgeFiles = [
      { name: "KharagolfWatchBridgeModule.m",     content: IOS_BRIDGE_HEADER,
        fileType: "sourcecode.c.objc" },
      { name: "KharagolfWatchBridgeModule.swift",  content: IOS_BRIDGE_IMPL,
        fileType: "sourcecode.swift" },
    ];

    const mainGroupKey = xcodeProject.findPBXGroupKey({ name: projectName });

    for (const { name, content, fileType } of bridgeFiles) {
      const fullPath     = path.join(appSrcDir, name);
      const relativePath = path.join(projectName, name);
      fs.writeFileSync(fullPath, content + "\n");

      // Register in Xcode project only if not already present.
      if (mainGroupKey && !xcodeProject.hasFile(relativePath)) {
        xcodeProject.addSourceFile(
          relativePath,
          { lastKnownFileType: fileType, sourceTree: "SOURCE_ROOT" },
          mainGroupKey,
        );
      }
    }

    return mod;
  });
};

const withWatchBridgeAndroid = (config) => {
  return withDangerousMod(config, ["android", (mod) => {
    const platformRoot = mod.modRequest.platformProjectRoot;
    const androidPackage = mod.android?.package ?? config.android?.package ?? "com.kharagolf.mobile";
    const packagePath = androidPackage.replace(/\./g, path.sep);
    const androidDir = path.join(platformRoot, "app", "src", "main", "java", packagePath);
    fs.mkdirSync(androidDir, { recursive: true });

    const patchPkg = (src) => src.replace(/^package com\.kharagolf\.mobile$/m, `package ${androidPackage}`);
    fs.writeFileSync(path.join(androidDir, "KharagolfWatchBridgeModule.kt"), patchPkg(ANDROID_BRIDGE_IMPL) + "\n");
    fs.writeFileSync(path.join(androidDir, "KharagolfWatchBridgePackage.kt"), patchPkg(ANDROID_PACKAGE_IMPL) + "\n");

    const mainAppPath = path.join(androidDir, "MainApplication.kt");
    if (!fs.existsSync(mainAppPath)) {
      throw new Error(
        `withWatchBridge: MainApplication.kt not found at ${mainAppPath}. ` +
        "Run expo prebuild before running this plugin."
      );
    }
    let mainApp = fs.readFileSync(mainAppPath, "utf8");
    if (!mainApp.includes("KharagolfWatchBridgePackage")) {
      mainApp = mainApp.replace(
        /^(import (?!com\.kharagolf\.mobile\.Kharagolf).+\n)(\n?class MainApplication)/m,
        `$1import ${androidPackage}.KharagolfWatchBridgePackage\n$2`,
      );
      mainApp = mainApp.replace(
        /(val packages = PackageList\(this\)\.packages)/,
        "$1\n        packages.add(KharagolfWatchBridgePackage())",
      );
      if (!mainApp.includes("KharagolfWatchBridgePackage()")) {
        mainApp = mainApp.replace(
          /PackageList\(this\)\.packages/,
          "PackageList(this).packages.also { it.add(KharagolfWatchBridgePackage()) }",
        );
      }
      if (!mainApp.includes("KharagolfWatchBridgePackage()")) {
        throw new Error(
          "withWatchBridge: failed to inject KharagolfWatchBridgePackage into MainApplication.kt. " +
          "Inspect the file and ensure getPackages() or PackageList is present."
        );
      }
      fs.writeFileSync(mainAppPath, mainApp);
    }

    const settingsGradlePath = path.join(platformRoot, "settings.gradle");
    if (fs.existsSync(settingsGradlePath)) {
      let settings = fs.readFileSync(settingsGradlePath, "utf8");
      if (!settings.includes(":wear-os-module")) {
        settings += `\ninclude ':wear-os-module'\nproject(':wear-os-module').projectDir = new File(rootDir, '../../wear-os-module')\n`;
        fs.writeFileSync(settingsGradlePath, settings);
      }
    }

    const appBuildGradlePath = path.join(platformRoot, "app", "build.gradle");
    if (fs.existsSync(appBuildGradlePath)) {
      let buildGradle = fs.readFileSync(appBuildGradlePath, "utf8");
      if (!buildGradle.includes("wearApp")) {
        buildGradle = buildGradle.replace(
          /dependencies\s*\{/,
          "dependencies {\n    wearApp project(':wear-os-module')",
        );
        fs.writeFileSync(appBuildGradlePath, buildGradle);
      }
    }

    return mod;
  }]);
};

module.exports = (config) => {
  config = withWatchBridgeIOS(config);
  config = withWatchBridgeAndroid(config);
  return config;
};
