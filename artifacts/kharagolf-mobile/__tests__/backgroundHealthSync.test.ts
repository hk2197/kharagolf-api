import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

type Platform = "ios" | "android" | "web";

interface Mocks {
  taskManager: {
    isTaskDefined: ReturnType<typeof vi.fn>;
    defineTask: ReturnType<typeof vi.fn>;
    isTaskRegisteredAsync: ReturnType<typeof vi.fn>;
    _taskBody: ((...args: unknown[]) => unknown) | null;
  };
  backgroundTask: {
    getStatusAsync: ReturnType<typeof vi.fn>;
    registerTaskAsync: ReturnType<typeof vi.fn>;
    unregisterTaskAsync: ReturnType<typeof vi.fn>;
    BackgroundTaskStatus: { Restricted: number; Available: number };
    BackgroundTaskResult: { Success: number; Failed: number };
  };
  secureStore: {
    getItemAsync: ReturnType<typeof vi.fn>;
  };
  appleHealth: {
    isAppleHealthSupported: ReturnType<typeof vi.fn>;
    syncAppleHealthLast7Days: ReturnType<typeof vi.fn>;
  };
}

let mocks: Mocks;

function makeMocks(): Mocks {
  return {
    taskManager: {
      isTaskDefined: vi.fn().mockReturnValue(false),
      defineTask: vi.fn(),
      isTaskRegisteredAsync: vi.fn().mockResolvedValue(false),
      _taskBody: null,
    },
    backgroundTask: {
      getStatusAsync: vi.fn().mockResolvedValue(1),
      registerTaskAsync: vi.fn().mockResolvedValue(undefined),
      unregisterTaskAsync: vi.fn().mockResolvedValue(undefined),
      BackgroundTaskStatus: { Restricted: 0, Available: 1 },
      BackgroundTaskResult: { Success: 1, Failed: 2 },
    },
    secureStore: {
      getItemAsync: vi.fn().mockResolvedValue(null),
    },
    appleHealth: {
      isAppleHealthSupported: vi.fn().mockReturnValue(true),
      syncAppleHealthLast7Days: vi.fn().mockResolvedValue({
        supported: true,
        authorized: true,
        daysWritten: 7,
        daysRead: 7,
      }),
    },
  };
}

async function loadModule(platform: Platform) {
  vi.resetModules();
  mocks = makeMocks();

  vi.doMock("react-native", () => ({ Platform: { OS: platform } }));
  vi.doMock("expo-secure-store", () => mocks.secureStore);
  vi.doMock("expo-task-manager", () => ({
    isTaskDefined: mocks.taskManager.isTaskDefined,
    defineTask: (name: string, body: (...a: unknown[]) => unknown) => {
      mocks.taskManager._taskBody = body;
      mocks.taskManager.defineTask(name, body);
    },
    isTaskRegisteredAsync: mocks.taskManager.isTaskRegisteredAsync,
  }));
  vi.doMock("expo-background-task", () => mocks.backgroundTask);
  vi.doMock("@/utils/appleHealth", () => mocks.appleHealth);

  return await import("../utils/backgroundHealthSync");
}

describe("backgroundHealthSync", () => {
  afterEach(() => {
    vi.doUnmock("react-native");
    vi.doUnmock("expo-secure-store");
    vi.doUnmock("expo-task-manager");
    vi.doUnmock("expo-background-task");
    vi.doUnmock("@/utils/appleHealth");
  });

  describe("on iOS", () => {
    it("defines the task at module load", async () => {
      const mod = await loadModule("ios");
      expect(mocks.taskManager.defineTask).toHaveBeenCalledWith(
        mod.BACKGROUND_HEALTH_SYNC_TASK,
        expect.any(Function),
      );
      expect(mod.BACKGROUND_HEALTH_SYNC_TASK).toBe("kharagolf-apple-health-sync");
    });

    it("does not redefine the task if already defined (fast refresh)", async () => {
      vi.resetModules();
      mocks = makeMocks();
      mocks.taskManager.isTaskDefined.mockReturnValue(true);
      vi.doMock("react-native", () => ({ Platform: { OS: "ios" } }));
      vi.doMock("expo-secure-store", () => mocks.secureStore);
      vi.doMock("expo-task-manager", () => ({
        isTaskDefined: mocks.taskManager.isTaskDefined,
        defineTask: mocks.taskManager.defineTask,
        isTaskRegisteredAsync: mocks.taskManager.isTaskRegisteredAsync,
      }));
      vi.doMock("expo-background-task", () => mocks.backgroundTask);
      vi.doMock("@/utils/appleHealth", () => mocks.appleHealth);

      await import("../utils/backgroundHealthSync");
      expect(mocks.taskManager.defineTask).not.toHaveBeenCalled();
    });

    it("registers the background task with a daily interval", async () => {
      const mod = await loadModule("ios");
      await mod.registerBackgroundHealthSync();
      expect(mocks.backgroundTask.registerTaskAsync).toHaveBeenCalledWith(
        mod.BACKGROUND_HEALTH_SYNC_TASK,
        { minimumInterval: 24 * 60 },
      );
    });

    it("does not register again if the task is already registered", async () => {
      const mod = await loadModule("ios");
      mocks.taskManager.isTaskRegisteredAsync.mockResolvedValue(true);
      await mod.registerBackgroundHealthSync();
      expect(mocks.backgroundTask.registerTaskAsync).not.toHaveBeenCalled();
    });

    it("skips registration when HealthKit is unsupported", async () => {
      const mod = await loadModule("ios");
      mocks.appleHealth.isAppleHealthSupported.mockReturnValue(false);
      await mod.registerBackgroundHealthSync();
      expect(mocks.backgroundTask.registerTaskAsync).not.toHaveBeenCalled();
    });

    it("skips registration when background tasks are restricted", async () => {
      const mod = await loadModule("ios");
      mocks.backgroundTask.getStatusAsync.mockResolvedValue(
        mocks.backgroundTask.BackgroundTaskStatus.Restricted,
      );
      await mod.registerBackgroundHealthSync();
      expect(mocks.backgroundTask.registerTaskAsync).not.toHaveBeenCalled();
    });

    it("unregisters the task on logout", async () => {
      const mod = await loadModule("ios");
      mocks.taskManager.isTaskRegisteredAsync.mockResolvedValue(true);
      await mod.unregisterBackgroundHealthSync();
      expect(mocks.backgroundTask.unregisterTaskAsync).toHaveBeenCalledWith(
        mod.BACKGROUND_HEALTH_SYNC_TASK,
      );
    });

    it("does not call unregister when no task is registered", async () => {
      const mod = await loadModule("ios");
      mocks.taskManager.isTaskRegisteredAsync.mockResolvedValue(false);
      await mod.unregisterBackgroundHealthSync();
      expect(mocks.backgroundTask.unregisterTaskAsync).not.toHaveBeenCalled();
    });

    it("swallows errors from the background scheduler", async () => {
      const mod = await loadModule("ios");
      mocks.backgroundTask.registerTaskAsync.mockRejectedValue(new Error("boom"));
      await expect(mod.registerBackgroundHealthSync()).resolves.toBeUndefined();
    });
  });

  describe("background task body", () => {
    it("calls syncAppleHealthLast7Days with the SecureStore token", async () => {
      await loadModule("ios");
      mocks.secureStore.getItemAsync.mockResolvedValue("player-token-abc");

      const body = mocks.taskManager._taskBody!;
      const result = await body();

      expect(mocks.secureStore.getItemAsync).toHaveBeenCalledWith(
        "kharagolf_player_token",
      );
      expect(mocks.appleHealth.syncAppleHealthLast7Days).toHaveBeenCalledWith(
        "player-token-abc",
      );
      expect(result).toBe(mocks.backgroundTask.BackgroundTaskResult.Success);
    });

    it("skips the sync when no player is signed in", async () => {
      await loadModule("ios");
      mocks.secureStore.getItemAsync.mockResolvedValue(null);

      const body = mocks.taskManager._taskBody!;
      const result = await body();

      expect(mocks.appleHealth.syncAppleHealthLast7Days).not.toHaveBeenCalled();
      expect(result).toBe(mocks.backgroundTask.BackgroundTaskResult.Success);
    });

    it("returns Failed when the sync throws", async () => {
      await loadModule("ios");
      mocks.secureStore.getItemAsync.mockResolvedValue("tok");
      mocks.appleHealth.syncAppleHealthLast7Days.mockRejectedValue(
        new Error("network down"),
      );

      const body = mocks.taskManager._taskBody!;
      const result = await body();

      expect(result).toBe(mocks.backgroundTask.BackgroundTaskResult.Failed);
    });

    it("returns Failed when SecureStore throws", async () => {
      await loadModule("ios");
      mocks.secureStore.getItemAsync.mockRejectedValue(new Error("locked"));

      const body = mocks.taskManager._taskBody!;
      const result = await body();

      expect(result).toBe(mocks.backgroundTask.BackgroundTaskResult.Failed);
      expect(mocks.appleHealth.syncAppleHealthLast7Days).not.toHaveBeenCalled();
    });
  });

  describe("on Android", () => {
    it("does not define the task at module load", async () => {
      await loadModule("android");
      expect(mocks.taskManager.defineTask).not.toHaveBeenCalled();
    });

    it("registerBackgroundHealthSync is a no-op", async () => {
      const mod = await loadModule("android");
      await mod.registerBackgroundHealthSync();
      expect(mocks.backgroundTask.getStatusAsync).not.toHaveBeenCalled();
      expect(mocks.backgroundTask.registerTaskAsync).not.toHaveBeenCalled();
    });

    it("unregisterBackgroundHealthSync is a no-op", async () => {
      const mod = await loadModule("android");
      await mod.unregisterBackgroundHealthSync();
      expect(mocks.taskManager.isTaskRegisteredAsync).not.toHaveBeenCalled();
      expect(mocks.backgroundTask.unregisterTaskAsync).not.toHaveBeenCalled();
    });
  });
});
