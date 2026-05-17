/**
 * Expo Config Plugin — KharagolfHealthKit Native Module
 *
 * Injects an iOS-only Swift module that reads daily sleep, HRV, resting heart
 * rate and step totals from Apple HealthKit. Android is not patched — the
 * JavaScript wrapper guards by Platform.OS === "ios" and treats the module as
 * absent on every other platform.
 *
 * The module exposes three React Native methods:
 *   isAvailable() -> Promise<boolean>
 *   requestAuthorization() -> Promise<boolean>
 *   readLast7Days() -> Promise<Array<{
 *     date: string,            // YYYY-MM-DD (device local time)
 *     sleepMinutes: number?,
 *     hrvMs: number?,          // average SDNN over the day
 *     restingHr: number?,      // most recent resting HR sample for the day
 *     steps: number?
 *   }>>
 *
 * The HealthKit entitlements and Info.plist usage strings already live in
 * app.json; this plugin only adds the bridge sources and registers them with
 * the Xcode project.
 */

const { withXcodeProject } = require("@expo/config-plugins");
const path = require("path");
const fs = require("fs");

const IOS_BRIDGE_HEADER = `
#import <React/RCTBridgeModule.h>
@interface KharagolfHealthKitModule : NSObject <RCTBridgeModule>
@end
`.trim();

const IOS_BRIDGE_IMPL = `
import Foundation
import HealthKit
import React

@objc(KharagolfHealthKitModule)
class KharagolfHealthKitModule: NSObject, RCTBridgeModule {
  static func moduleName() -> String! { "KharagolfHealthKit" }
  static func requiresMainQueueSetup() -> Bool { false }

  private let store = HKHealthStore()

  private var readTypes: Set<HKObjectType> {
    var set = Set<HKObjectType>()
    if let t = HKObjectType.categoryType(forIdentifier: .sleepAnalysis)               { set.insert(t) }
    if let t = HKObjectType.quantityType(forIdentifier: .heartRateVariabilitySDNN)    { set.insert(t) }
    if let t = HKObjectType.quantityType(forIdentifier: .restingHeartRate)            { set.insert(t) }
    if let t = HKObjectType.quantityType(forIdentifier: .stepCount)                   { set.insert(t) }
    return set
  }

  @objc func isAvailable(_ resolve: @escaping RCTPromiseResolveBlock,
                         rejecter reject: @escaping RCTPromiseRejectBlock) {
    resolve(HKHealthStore.isHealthDataAvailable())
  }

  @objc func requestAuthorization(_ resolve: @escaping RCTPromiseResolveBlock,
                                  rejecter reject: @escaping RCTPromiseRejectBlock) {
    guard HKHealthStore.isHealthDataAvailable() else {
      resolve(false)
      return
    }
    store.requestAuthorization(toShare: nil, read: readTypes) { success, error in
      if let error = error {
        reject("HEALTHKIT_AUTH", error.localizedDescription, error as NSError)
      } else {
        resolve(success)
      }
    }
  }

  @objc func readLast7Days(_ resolve: @escaping RCTPromiseResolveBlock,
                           rejecter reject: @escaping RCTPromiseRejectBlock) {
    guard HKHealthStore.isHealthDataAvailable() else {
      resolve([])
      return
    }
    let calendar = Calendar.current
    let now = Date()
    let today = calendar.startOfDay(for: now)
    guard let earliest = calendar.date(byAdding: .day, value: -6, to: today) else {
      resolve([])
      return
    }
    let isoFormatter = DateFormatter()
    isoFormatter.calendar = calendar
    isoFormatter.dateFormat = "yyyy-MM-dd"

    // Initialise day buckets so missing metrics surface as nil rather than
    // dropping the day entirely.
    var days: [(date: Date, key: String)] = []
    for offset in 0...6 {
      if let d = calendar.date(byAdding: .day, value: offset, to: earliest) {
        days.append((d, isoFormatter.string(from: d)))
      }
    }
    var result: [String: [String: Any]] = [:]
    for d in days { result[d.key] = ["date": d.key] }

    let group = DispatchGroup()
    var firstError: Error?

    // ── Sleep (sum of asleep minutes per local day) ───────────────────────
    if let sleepType = HKObjectType.categoryType(forIdentifier: .sleepAnalysis) {
      group.enter()
      let predicate = HKQuery.predicateForSamples(withStart: earliest,
                                                  end: calendar.date(byAdding: .day, value: 1, to: today),
                                                  options: .strictStartDate)
      let q = HKSampleQuery(sampleType: sleepType, predicate: predicate, limit: HKObjectQueryNoLimit, sortDescriptors: nil) { _, samples, error in
        defer { group.leave() }
        if let error = error { firstError = firstError ?? error; return }
        guard let samples = samples as? [HKCategorySample] else { return }
        var totals: [String: Double] = [:]
        for s in samples {
          // iOS 16+ uses asleepCore/asleepDeep/asleepREM; older releases use
          // the legacy 'asleep' value. Both are surfaced as integers.
          let asleepValues: Set<Int>
          if #available(iOS 16.0, *) {
            asleepValues = [
              HKCategoryValueSleepAnalysis.asleepUnspecified.rawValue,
              HKCategoryValueSleepAnalysis.asleepCore.rawValue,
              HKCategoryValueSleepAnalysis.asleepDeep.rawValue,
              HKCategoryValueSleepAnalysis.asleepREM.rawValue,
            ]
          } else {
            asleepValues = [HKCategoryValueSleepAnalysis.asleep.rawValue]
          }
          if !asleepValues.contains(s.value) { continue }
          // Bucket by the local day in which the sample ENDS — keeps an
          // overnight session in the morning's day, matching how Apple Health
          // and most wearables report it.
          let dayStart = calendar.startOfDay(for: s.endDate)
          let key = isoFormatter.string(from: dayStart)
          let minutes = s.endDate.timeIntervalSince(s.startDate) / 60.0
          totals[key, default: 0] += minutes
        }
        for (key, mins) in totals {
          if result[key] != nil { result[key]!["sleepMinutes"] = Int(mins.rounded()) }
        }
      }
      store.execute(q)
    }

    // ── HRV (average SDNN ms per day) ─────────────────────────────────────
    if let hrvType = HKObjectType.quantityType(forIdentifier: .heartRateVariabilitySDNN) {
      group.enter()
      let predicate = HKQuery.predicateForSamples(withStart: earliest,
                                                  end: calendar.date(byAdding: .day, value: 1, to: today),
                                                  options: .strictStartDate)
      let q = HKSampleQuery(sampleType: hrvType, predicate: predicate, limit: HKObjectQueryNoLimit, sortDescriptors: nil) { _, samples, error in
        defer { group.leave() }
        if let error = error { firstError = firstError ?? error; return }
        guard let samples = samples as? [HKQuantitySample] else { return }
        var sums: [String: Double] = [:]
        var counts: [String: Int] = [:]
        let unit = HKUnit.secondUnit(with: .milli)
        for s in samples {
          let key = isoFormatter.string(from: calendar.startOfDay(for: s.startDate))
          sums[key, default: 0] += s.quantity.doubleValue(for: unit)
          counts[key, default: 0] += 1
        }
        for (key, sum) in sums {
          let n = counts[key] ?? 0
          if n > 0, result[key] != nil {
            result[key]!["hrvMs"] = sum / Double(n)
          }
        }
      }
      store.execute(q)
    }

    // ── Resting Heart Rate (last sample of each day) ──────────────────────
    if let rhrType = HKObjectType.quantityType(forIdentifier: .restingHeartRate) {
      group.enter()
      let predicate = HKQuery.predicateForSamples(withStart: earliest,
                                                  end: calendar.date(byAdding: .day, value: 1, to: today),
                                                  options: .strictStartDate)
      let sort = NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: false)
      let q = HKSampleQuery(sampleType: rhrType, predicate: predicate, limit: HKObjectQueryNoLimit, sortDescriptors: [sort]) { _, samples, error in
        defer { group.leave() }
        if let error = error { firstError = firstError ?? error; return }
        guard let samples = samples as? [HKQuantitySample] else { return }
        let unit = HKUnit.count().unitDivided(by: .minute())
        // samples already sorted DESC; first encounter per day is most recent.
        for s in samples {
          let key = isoFormatter.string(from: calendar.startOfDay(for: s.startDate))
          if result[key]?["restingHr"] != nil { continue }
          if result[key] != nil {
            result[key]!["restingHr"] = Int(s.quantity.doubleValue(for: unit).rounded())
          }
        }
      }
      store.execute(q)
    }

    // ── Steps (sum per day via statistics collection) ─────────────────────
    if let stepType = HKObjectType.quantityType(forIdentifier: .stepCount) {
      group.enter()
      let interval = DateComponents(day: 1)
      let q = HKStatisticsCollectionQuery(quantityType: stepType,
                                          quantitySamplePredicate: nil,
                                          options: .cumulativeSum,
                                          anchorDate: earliest,
                                          intervalComponents: interval)
      q.initialResultsHandler = { _, results, error in
        defer { group.leave() }
        if let error = error { firstError = firstError ?? error; return }
        guard let results = results else { return }
        results.enumerateStatistics(from: earliest, to: calendar.date(byAdding: .day, value: 1, to: today)!) { stats, _ in
          let key = isoFormatter.string(from: calendar.startOfDay(for: stats.startDate))
          if let sum = stats.sumQuantity(), result[key] != nil {
            result[key]!["steps"] = Int(sum.doubleValue(for: HKUnit.count()).rounded())
          }
        }
      }
      store.execute(q)
    }

    // Wait off the JS thread.
    group.notify(queue: DispatchQueue.global(qos: .userInitiated)) {
      if let error = firstError {
        reject("HEALTHKIT_READ", error.localizedDescription, error as NSError)
        return
      }
      // Return chronological order, oldest -> newest.
      let ordered = days.map { d -> [String: Any] in result[d.key] ?? ["date": d.key] }
      resolve(ordered)
    }
  }
}
`.trim();

const withHealthKitBridgeIOS = (config) => {
  return withXcodeProject(config, (mod) => {
    const iosDir = mod.modRequest.platformProjectRoot;
    const xcodeProject = mod.modResults;
    const projectName = mod.modRequest.projectName;

    const appSrcDir = path.join(iosDir, projectName);
    fs.mkdirSync(appSrcDir, { recursive: true });

    const bridgeFiles = [
      { name: "KharagolfHealthKitModule.m", content: IOS_BRIDGE_HEADER, fileType: "sourcecode.c.objc" },
      { name: "KharagolfHealthKitModule.swift", content: IOS_BRIDGE_IMPL, fileType: "sourcecode.swift" },
    ];

    const mainGroupKey = xcodeProject.findPBXGroupKey({ name: projectName });

    for (const { name, content, fileType } of bridgeFiles) {
      const fullPath = path.join(appSrcDir, name);
      const relativePath = path.join(projectName, name);
      fs.writeFileSync(fullPath, content + "\n");

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

module.exports = (config) => {
  config = withHealthKitBridgeIOS(config);
  return config;
};
