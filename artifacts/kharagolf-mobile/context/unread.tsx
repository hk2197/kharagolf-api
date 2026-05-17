import AsyncStorage from "@react-native-async-storage/async-storage";
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";

const LAST_SEEN_KEY = "kharagolf_updates_last_seen";

interface UnreadContextValue {
  unreadCount: number;
  lastSeenAt: number;
  setUnreadCount: (count: number) => void;
  markAllRead: () => Promise<void>;
  /** Unread count for handicap-committee notifications (the bell tab). */
  notifUnreadCount: number;
  setNotifUnreadCount: (count: number) => void;
}

const UnreadContext = createContext<UnreadContextValue | null>(null);

export function UnreadProvider({ children }: { children: React.ReactNode }) {
  const [unreadCount, setUnreadCountState] = useState(0);
  const [lastSeenAt, setLastSeenAt] = useState<number>(0);
  const [notifUnreadCount, setNotifUnreadCountState] = useState(0);

  // Hydrate last-seen timestamp from storage on mount
  useEffect(() => {
    AsyncStorage.getItem(LAST_SEEN_KEY)
      .then((val) => {
        if (val) setLastSeenAt(parseInt(val, 10));
      })
      .catch(() => {});
  }, []);

  const setUnreadCount = useCallback((count: number) => {
    setUnreadCountState(count);
  }, []);

  const setNotifUnreadCount = useCallback((count: number) => {
    setNotifUnreadCountState(Math.max(0, count | 0));
  }, []);

  const markAllRead = useCallback(async () => {
    const now = Date.now();
    setLastSeenAt(now);
    setUnreadCountState(0);
    try {
      await AsyncStorage.setItem(LAST_SEEN_KEY, String(now));
    } catch {}
  }, []);

  return (
    <UnreadContext.Provider
      value={{
        unreadCount,
        lastSeenAt,
        setUnreadCount,
        markAllRead,
        notifUnreadCount,
        setNotifUnreadCount,
      }}
    >
      {children}
    </UnreadContext.Provider>
  );
}

export function useUnread(): UnreadContextValue {
  const ctx = useContext(UnreadContext);
  if (!ctx) throw new Error("useUnread must be used inside UnreadProvider");
  return ctx;
}
