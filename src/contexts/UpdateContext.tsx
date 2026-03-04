import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useRef,
} from "react";
import type { UpdateInfo, UpdateHandle } from "../lib/updater";
import { checkForUpdate } from "../lib/updater";

interface UpdateContextValue {
  hasUpdate: boolean;
  updateInfo: UpdateInfo | null;
  updateHandle: UpdateHandle | null;
  isChecking: boolean;
  error: string | null;
  isDismissed: boolean;
  dismissUpdate: () => void;
  checkUpdate: () => Promise<boolean>;
  resetDismiss: () => void;
}

const UpdateContext = createContext<UpdateContextValue | undefined>(undefined);

export function UpdateProvider({ children }: { children: React.ReactNode }) {
  const DISMISSED_VERSION_KEY = "ccswitch:update:dismissedVersion";
  const LEGACY_DISMISSED_KEY = "dismissedUpdateVersion"; // backward compatible legacy key

  const [hasUpdate, setHasUpdate] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [updateHandle, setUpdateHandle] = useState<UpdateHandle | null>(null);
  const [isChecking, setIsChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isDismissed, setIsDismissed] = useState(false);

  // Read dismissed version from localStorage.
  useEffect(() => {
    const current = updateInfo?.availableVersion;
    if (!current) return;

    // Read new key first. If missing, migrate from legacy key.
    let dismissedVersion = localStorage.getItem(DISMISSED_VERSION_KEY);
    if (!dismissedVersion) {
      const legacy = localStorage.getItem(LEGACY_DISMISSED_KEY);
      if (legacy) {
        localStorage.setItem(DISMISSED_VERSION_KEY, legacy);
        localStorage.removeItem(LEGACY_DISMISSED_KEY);
        dismissedVersion = legacy;
      }
    }

    setIsDismissed(dismissedVersion === current);
  }, [updateInfo?.availableVersion]);

  const isCheckingRef = useRef(false);

  const checkUpdate = useCallback(async () => {
    if (isCheckingRef.current) return false;
    isCheckingRef.current = true;
    setIsChecking(true);
    setError(null);

    try {
      const result = await checkForUpdate({ timeout: 30000 });

      if (result.status === "available") {
        setHasUpdate(true);
        setUpdateInfo(result.info);
        setUpdateHandle(result.update);

        // Check whether this available version has been dismissed.
        let dismissedVersion = localStorage.getItem(DISMISSED_VERSION_KEY);
        if (!dismissedVersion) {
          const legacy = localStorage.getItem(LEGACY_DISMISSED_KEY);
          if (legacy) {
            localStorage.setItem(DISMISSED_VERSION_KEY, legacy);
            localStorage.removeItem(LEGACY_DISMISSED_KEY);
            dismissedVersion = legacy;
          }
        }
        setIsDismissed(dismissedVersion === result.info.availableVersion);
        return true; // 有更新
      } else {
        setHasUpdate(false);
        setUpdateInfo(null);
        setUpdateHandle(null);
        setIsDismissed(false);
        return false; // already latest
      }
    } catch (err) {
      console.error("Update check failed", err);
      setError(err instanceof Error ? err.message : "Update check failed");
      setHasUpdate(false);
      throw err; // rethrow to caller
    } finally {
      setIsChecking(false);
      isCheckingRef.current = false;
    }
  }, []);

  const dismissUpdate = useCallback(() => {
    setIsDismissed(true);
    if (updateInfo?.availableVersion) {
      localStorage.setItem(DISMISSED_VERSION_KEY, updateInfo.availableVersion);
      // clean legacy key
      localStorage.removeItem(LEGACY_DISMISSED_KEY);
    }
  }, [updateInfo?.availableVersion]);

  const resetDismiss = useCallback(() => {
    setIsDismissed(false);
    localStorage.removeItem(DISMISSED_VERSION_KEY);
    localStorage.removeItem(LEGACY_DISMISSED_KEY);
  }, []);

  const value: UpdateContextValue = {
    hasUpdate,
    updateInfo,
    updateHandle,
    isChecking,
    error,
    isDismissed,
    dismissUpdate,
    checkUpdate,
    resetDismiss,
  };

  return (
    <UpdateContext.Provider value={value}>{children}</UpdateContext.Provider>
  );
}

export function useUpdate() {
  const context = useContext(UpdateContext);
  if (!context) {
    throw new Error("useUpdate must be used within UpdateProvider");
  }
  return context;
}
