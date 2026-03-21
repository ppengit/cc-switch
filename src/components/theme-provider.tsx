import React, {
  createContext,
  useContext,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { useSaveSettingsMutation, useSettingsQuery } from "@/lib/query";
import { settingsApi } from "@/lib/api";
import type { Settings } from "@/types";

type Theme = "light" | "dark" | "system";

const normalizeTheme = (value?: string | null): Theme => {
  if (typeof value !== "string" || !value) return "system";
  const normalized = value.toLowerCase();
  return normalized === "light" ||
    normalized === "dark" ||
    normalized === "system"
    ? (normalized as Theme)
    : "system";
};

interface ThemeProviderProps {
  children: React.ReactNode;
  defaultTheme?: Theme;
  storageKey?: string;
}

interface ThemeContextValue {
  theme: Theme;
  setTheme: (theme: Theme, event?: React.MouseEvent) => void;
}

const ThemeProviderContext = createContext<ThemeContextValue | undefined>(
  undefined,
);

export function ThemeProvider({
  children,
  defaultTheme = "system",
  storageKey = "cc-switch-theme",
}: ThemeProviderProps) {
  const { data: settingsData } = useSettingsQuery();
  const saveMutation = useSaveSettingsMutation();
  const hasSyncedSettingsTheme = useRef(false);

  const getInitialTheme = () => {
    if (typeof window === "undefined") {
      return defaultTheme;
    }

    const stored = window.localStorage.getItem(storageKey) as Theme | null;
    if (stored === "light" || stored === "dark" || stored === "system") {
      return stored;
    }

    return defaultTheme;
  };

  const [theme, setThemeState] = useState<Theme>(getInitialTheme);

  const persistTheme = useCallback(
    async (nextTheme: Theme) => {
      try {
        const base: Settings = settingsData ?? (await settingsApi.get());
        const shouldPersist =
          !base.theme || normalizeTheme(base.theme) !== nextTheme;
        if (!shouldPersist) return;
        const { webdavSync: _ignoredWebdavSync, ...rest } = base;
        await saveMutation.mutateAsync({
          ...rest,
          theme: nextTheme,
        });
      } catch (error) {
        console.warn("[ThemeProvider] Failed to persist theme", error);
      }
    },
    [saveMutation, settingsData],
  );

  useEffect(() => {
    if (!settingsData) return;

    const incomingTheme = settingsData.theme;
    if (incomingTheme) {
      const normalized = normalizeTheme(incomingTheme);
      if (normalized !== theme) {
        setThemeState(normalized);
      }
      hasSyncedSettingsTheme.current = true;
      return;
    }

    if (!hasSyncedSettingsTheme.current) {
      hasSyncedSettingsTheme.current = true;
      void persistTheme(theme);
    }
  }, [persistTheme, settingsData, theme]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    window.localStorage.setItem(storageKey, theme);
  }, [theme, storageKey]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const root = window.document.documentElement;
    root.classList.remove("light", "dark");

    if (theme === "system") {
      const isDark =
        window.matchMedia &&
        window.matchMedia("(prefers-color-scheme: dark)").matches;
      root.classList.add(isDark ? "dark" : "light");
      return;
    }

    root.classList.add(theme);
  }, [theme]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = () => {
      if (theme !== "system") {
        return;
      }

      const root = window.document.documentElement;
      root.classList.toggle("dark", mediaQuery.matches);
      root.classList.toggle("light", !mediaQuery.matches);
    };

    if (theme === "system") {
      handleChange();
    }

    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, [theme]);

  // Sync native window theme (Windows/macOS title bar)
  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    let isCancelled = false;

    const updateNativeTheme = async (nativeTheme: string) => {
      if (isCancelled) return;
      try {
        await invoke("set_window_theme", { theme: nativeTheme });
      } catch (e) {
        // Ignore errors (e.g., when not running in Tauri)
        console.debug("Failed to set native window theme:", e);
      }
    };

    // When "system", pass "system" so Tauri uses None (follows OS theme natively).
    // This keeps the WebView's prefers-color-scheme in sync with the real OS theme,
    // allowing effect #3's media query listener to fire on system theme changes.
    if (theme === "system") {
      updateNativeTheme("system");
    } else {
      updateNativeTheme(theme);
    }

    return () => {
      isCancelled = true;
    };
  }, [theme]);

  const value = useMemo<ThemeContextValue>(
    () => ({
      theme,
      setTheme: (nextTheme: Theme, event?: React.MouseEvent) => {
        // Skip if same theme
        if (nextTheme === theme) return;

        // Set transition origin coordinates from click event
        const x = event?.clientX ?? window.innerWidth / 2;
        const y = event?.clientY ?? window.innerHeight / 2;
        document.documentElement.style.setProperty(
          "--theme-transition-x",
          `${x}px`,
        );
        document.documentElement.style.setProperty(
          "--theme-transition-y",
          `${y}px`,
        );

        // Use View Transitions API if available, otherwise fall back to instant change
        if (document.startViewTransition) {
          document.startViewTransition(() => {
            setThemeState(nextTheme);
          });
        } else {
          setThemeState(nextTheme);
        }

        void persistTheme(nextTheme);
      },
    }),
    [persistTheme, theme],
  );

  return (
    <ThemeProviderContext.Provider value={value}>
      {children}
    </ThemeProviderContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeProviderContext);
  if (context === undefined) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return context;
}
