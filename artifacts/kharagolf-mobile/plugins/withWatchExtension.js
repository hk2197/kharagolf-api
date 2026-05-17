/**
 * Expo Config Plugin — KHARAGOLF WatchKit Extension
 *
 * Injects a standalone WatchKit app target into the Xcode project during
 * `expo prebuild` / EAS Build. The watch app (Xcode 14+ single-target model)
 * is registered as "KHARAGOLFWatch" and embedded into the main app via a
 * dedicated Embed Watch Content build phase.
 *
 * What this plugin does automatically:
 *   1. Adds App Groups entitlement to the phone app (shared UserDefaults).
 *   2. Copies Swift source files from ios-watch-extension/ into ios/KHARAGOLFWatch/.
 *   3. Creates a WatchKit App native Xcode target (PRODUCT_TYPE watchapp2).
 *   4. Adds a Sources build phase containing all .swift files.
 *   5. Configures Debug + Release XCBuildConfiguration for the watch target.
 *   6. Adds a target dependency from the phone app to the watch app.
 *   7. Adds an Embed Watch Content build phase to the phone app so the
 *      watch bundle is included in the final .ipa.
 *
 * Requirements:
 *   - Xcode 14+ (watchOS 9+ standalone model — no separate extension target)
 *   - Apple Developer account with WatchKit capability
 */

const { withXcodeProject, withEntitlementsPlist } = require("@expo/config-plugins");
const path = require("path");
const fs = require("fs");

// ── Constants ──────────────────────────────────────────────────────────────────

const WATCH_TARGET_NAME       = "KHARAGOLFWatch";
const APP_GROUP               = "group.com.kharagolf.mobile";
const WATCH_BUNDLE_ID         = "com.kharagolf.mobile.watchkitapp";
const WATCHOS_DEPLOYMENT_TARGET = "9.0";

// Xcode product types
const WATCH_APP_PRODUCT_TYPE  = "com.apple.product-type.application.watchapp2";
const WATCH_APP_WRAPPER_EXT   = "app";

// ── Step 1: App Groups entitlement ────────────────────────────────────────────

const withAppGroupEntitlement = (config) => {
  return withEntitlementsPlist(config, (mod) => {
    const ents = mod.modResults;
    if (!ents["com.apple.security.application-groups"]) {
      ents["com.apple.security.application-groups"] = [];
    }
    if (!ents["com.apple.security.application-groups"].includes(APP_GROUP)) {
      ents["com.apple.security.application-groups"].push(APP_GROUP);
    }
    return mod;
  });
};

// ── Step 2: Copy sources + create Xcode target ─────────────────────────────────

const withWatchTarget = (config) => {
  return withXcodeProject(config, (mod) => {
    const iosDir       = mod.modRequest.platformProjectRoot;
    const xcodeProject = mod.modResults;

    // 2a. Copy Swift sources into ios/KHARAGOLFWatch/
    const watchDir  = path.join(iosDir, WATCH_TARGET_NAME);
    const sourceDir = path.join(__dirname, "..", "ios-watch-extension", "KHARAGOLFWatch");

    if (!fs.existsSync(watchDir)) {
      fs.mkdirSync(watchDir, { recursive: true });
    }
    if (fs.existsSync(sourceDir)) {
      fs.readdirSync(sourceDir).forEach((file) => {
        const src = path.join(sourceDir, file);
        const dst = path.join(watchDir, file);
        if (!fs.existsSync(dst)) {
          fs.copyFileSync(src, dst);
        }
      });
    }

    // 2b. Bail early if watch target already exists (idempotent)
    const existingTargets = xcodeProject.pbxNativeTargetSection() ?? {};
    const alreadyExists = Object.values(existingTargets).some(
      (t) => t && t.name === WATCH_TARGET_NAME,
    );
    if (alreadyExists) {
      return mod;
    }

    // 2c. Create a new PBXGroup for the watch sources
    const watchGroupKey = xcodeProject.pbxCreateGroup(WATCH_TARGET_NAME, WATCH_TARGET_NAME);

    // 2d. Add Swift source files to the group and collect file references
    const swiftFiles = fs.existsSync(watchDir)
      ? fs.readdirSync(watchDir).filter((f) => f.endsWith(".swift"))
      : [];

    const sourcesBuildFiles = swiftFiles.map((file) => {
      const fileRef = xcodeProject.addFile(
        path.join(WATCH_TARGET_NAME, file),
        watchGroupKey,
        { lastKnownFileType: "sourcecode.swift", sourceTree: "SOURCE_ROOT" },
      );
      return fileRef;
    });

    // 2e. Create the native target
    const watchTarget = xcodeProject.addTarget(
      WATCH_TARGET_NAME,
      WATCH_APP_PRODUCT_TYPE,
      WATCH_TARGET_NAME,
    );

    // 2f. Add Sources build phase to the watch target
    xcodeProject.addBuildPhase(
      swiftFiles.map((f) => path.join(WATCH_TARGET_NAME, f)),
      "PBXSourcesBuildPhase",
      "Sources",
      watchTarget.uuid,
    );

    // 2g. Add Resources build phase — registers non-source artifacts (privacy manifest, assets).
    const resourceFiles = ["PrivacyInfo.xcprivacy"];
    resourceFiles.forEach((file) => {
      if (fs.existsSync(path.join(watchDir, file))) {
        xcodeProject.addFile(
          path.join(WATCH_TARGET_NAME, file),
          watchGroupKey,
          { lastKnownFileType: "text.xml", sourceTree: "SOURCE_ROOT" },
        );
      }
    });
    xcodeProject.addBuildPhase(
      resourceFiles.map((f) => path.join(WATCH_TARGET_NAME, f)),
      "PBXResourcesBuildPhase",
      "Resources",
      watchTarget.uuid,
    );

    // 2h. Build settings for Debug and Release
    const watchBuildSettings = {
      PRODUCT_NAME:                WATCH_TARGET_NAME,
      PRODUCT_BUNDLE_IDENTIFIER:   WATCH_BUNDLE_ID,
      WATCHOS_DEPLOYMENT_TARGET:   WATCHOS_DEPLOYMENT_TARGET,
      TARGETED_DEVICE_FAMILY:      "4",
      SDKROOT:                     "watchos",
      SUPPORTED_PLATFORMS:         "watchos watchsimulator",
      SWIFT_VERSION:               "5.0",
      MARKETING_VERSION:           "1.0",
      CURRENT_PROJECT_VERSION:     "1",
      INFOPLIST_FILE:              `${WATCH_TARGET_NAME}/Info.plist`,
      CODE_SIGN_ENTITLEMENTS:      `${WATCH_TARGET_NAME}/KHARAGOLFWatch.entitlements`,
      ASSETCATALOG_COMPILER_APPICON_NAME: "AppIcon",
      SKIP_INSTALL:                "NO",
      CODE_SIGN_STYLE:             "Automatic",
    };

    const configList = xcodeProject.pbxXCConfigurationListSection();
    Object.keys(configList).forEach((key) => {
      const entry = configList[key];
      if (entry && Array.isArray(entry.buildConfigurations)) {
        // Only patch configuration lists that belong to the new watch target
        const ownerComment = configList[`${key}_comment`] ?? "";
        if (ownerComment === WATCH_TARGET_NAME) {
          entry.buildConfigurations.forEach((ref) => {
            const cfgKey = ref.value;
            const cfg = xcodeProject.pbxXCBuildConfigurationSection()[cfgKey];
            if (cfg) {
              cfg.buildSettings = {
                ...cfg.buildSettings,
                ...watchBuildSettings,
              };
            }
          });
        }
      }
    });

    // 2h. Write a minimal Info.plist for the watch target
    const infoPlistPath = path.join(watchDir, "Info.plist");
    if (!fs.existsSync(infoPlistPath)) {
      fs.writeFileSync(
        infoPlistPath,
        `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDisplayName</key>
  <string>KHARAGOLF</string>
  <key>CFBundleExecutable</key>
  <string>$(EXECUTABLE_NAME)</string>
  <key>CFBundleIdentifier</key>
  <string>${WATCH_BUNDLE_ID}</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>$(PRODUCT_NAME)</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>WKApplication</key>
  <true/>
  <key>WKCompanionAppBundleIdentifier</key>
  <string>com.kharagolf.mobile</string>
</dict>
</plist>`,
      );
    }

    // 2i. Add target dependency from phone app to watch app
    const mainTargets = Object.values(xcodeProject.pbxNativeTargetSection() ?? {}).filter(
      (t) => t && t.name && t.name !== WATCH_TARGET_NAME && typeof t.name === "string",
    );
    if (mainTargets.length > 0 && watchTarget.uuid) {
      const mainTargetKey = Object.keys(xcodeProject.pbxNativeTargetSection() ?? {}).find(
        (k) => xcodeProject.pbxNativeTargetSection()[k] === mainTargets[0],
      );
      if (mainTargetKey) {
        xcodeProject.addTargetDependency(mainTargetKey, [watchTarget.uuid]);
      }
    }

    // 2j. Add "Embed Watch Content" copy files build phase to phone app
    // (copies the .app bundle into PlugIns/ of the .ipa)
    if (mainTargets.length > 0) {
      xcodeProject.addBuildPhase(
        [`${WATCH_TARGET_NAME}.app`],
        "PBXCopyFilesBuildPhase",
        "Embed Watch Content",
        Object.keys(xcodeProject.pbxNativeTargetSection() ?? {}).find(
          (k) => xcodeProject.pbxNativeTargetSection()[k] === mainTargets[0],
        ),
        {
          shellPath: "/bin/sh",
          shellScript: "",
          dstPath: "$(CONTENTS_FOLDER_PATH)/Watch",
          dstSubfolderSpec: 16,  // Watch subfolder
        },
      );
    }

    return mod;
  });
};

// ── Compose plugin ─────────────────────────────────────────────────────────────

module.exports = (config) => {
  config = withAppGroupEntitlement(config);
  config = withWatchTarget(config);
  return config;
};
