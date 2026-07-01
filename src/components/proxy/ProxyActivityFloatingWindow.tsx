import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pin, PinOff, X } from "lucide-react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  cursorPosition,
  getCurrentWindow,
  PhysicalPosition,
  PhysicalSize,
} from "@tauri-apps/api/window";
import { proxyApi } from "@/lib/api/proxy";
import type {
  ActiveRequestTarget,
  ProxyActivityEvent,
  ProxyActivityFloatingPosition,
  ProxyActivityFloatingSettings,
} from "@/types/proxy";
import {
  getActivityDisplayModel,
  normalizeActiveRequestTargets,
} from "@/lib/proxyActivity";
import { cn } from "@/lib/utils";
import "@/i18n";

const PANEL_WIDTH = 320;
const PANEL_HEIGHT = 142;
const DEFAULT_IDLE_HIDE_SECONDS = 180;

interface Point {
  x: number;
  y: number;
}

function normalizePosition(
  position?: ProxyActivityFloatingPosition | null,
): Point | undefined {
  if (
    !position ||
    !Number.isFinite(position.x) ||
    !Number.isFinite(position.y)
  ) {
    return undefined;
  }
  return { x: position.x, y: position.y };
}

function appLabel(appType?: string | null) {
  const normalized = (appType || "codex").trim();
  if (!normalized) return "CODEX";
  return normalized.replace(/[-_]+/g, " ").toUpperCase();
}

function displayText(value?: string | null) {
  const trimmed = (value || "").trim();
  return trimmed || "-";
}

function targetTitle(target: ActiveRequestTarget) {
  return [
    appLabel(target.app_type),
    displayText(target.provider_name),
    displayText(getActivityDisplayModel(target)),
    `请求 ${target.inflight_requests}`,
  ].join(" · ");
}

async function readPointerScreenPosition(
  event: React.PointerEvent<HTMLDivElement>,
): Promise<Point> {
  try {
    const position = await cursorPosition();
    return { x: position.x, y: position.y };
  } catch {
    return { x: event.screenX, y: event.screenY };
  }
}

export function ProxyActivityFloatingWindow() {
  const appWindow = useMemo(() => getCurrentWindow(), []);
  const [targets, setTargets] = useState<ActiveRequestTarget[]>([]);
  const [alwaysOnTop, setAlwaysOnTop] = useState(true);
  const [settings, setSettings] = useState<ProxyActivityFloatingSettings>({
    visible: true,
    opacity: 0.86,
    idleHideSeconds: DEFAULT_IDLE_HIDE_SECONDS,
    alwaysOnTop: true,
    mode: "panel",
    position: null,
  });
  const dragRef = useRef<{
    pointerId: number;
    startCursor: Point;
    startWindow: Point;
    moveSeq: number;
  } | null>(null);
  const countRef = useRef(0);
  const settingsRef = useRef(settings);
  const idleHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const positionRef = useRef<Point>({ x: 0, y: 0 });

  const visibleTargets = useMemo(() => targets, [targets]);
  const opacity = Math.min(1, Math.max(0.35, settings.opacity || 0.86));
  const idleHideDelayMs =
    Math.max(
      10,
      Math.min(3600, settings.idleHideSeconds || DEFAULT_IDLE_HIDE_SECONDS),
    ) * 1000;

  const moveWindow = useCallback(
    async (pos: Point) => {
      positionRef.current = pos;
      await appWindow.setPosition(
        new PhysicalPosition(Math.round(pos.x), Math.round(pos.y)),
      );
    },
    [appWindow],
  );

  const resizeWindow = useCallback(async () => {
    await appWindow.setSize(new PhysicalSize(PANEL_WIDTH, PANEL_HEIGHT));
  }, [appWindow]);

  const clearIdleHideTimer = useCallback(() => {
    if (idleHideTimerRef.current) {
      clearTimeout(idleHideTimerRef.current);
      idleHideTimerRef.current = null;
    }
  }, []);

  const syncRuntimeVisibility = useCallback(
    (activeCount: number, enabled: boolean, hideImmediately = false) => {
      clearIdleHideTimer();
      if (!enabled) return;

      if (activeCount > 0) {
        void appWindow
          .show()
          .then(() => appWindow.setAlwaysOnTop(settingsRef.current.alwaysOnTop))
          .catch((error) => console.debug("显示实时请求浮窗失败", error));
        return;
      }

      const hide = () => {
        void appWindow
          .hide()
          .catch((error) => console.debug("空闲隐藏实时请求浮窗失败", error));
      };

      if (hideImmediately) {
        hide();
      } else {
        idleHideTimerRef.current = setTimeout(hide, idleHideDelayMs);
      }
    },
    [appWindow, clearIdleHideTimer, idleHideDelayMs],
  );

  const persistPosition = useCallback(async (pos = positionRef.current) => {
    try {
      await proxyApi.setProxyActivityFloatingPosition({
        x: Math.round(pos.x),
        y: Math.round(pos.y),
      });
    } catch (error) {
      console.debug("保存实时请求浮窗位置失败", error);
    }
  }, []);

  const settlePosition = useCallback(async () => {
    try {
      const position = await appWindow.outerPosition();
      positionRef.current = { x: position.x, y: position.y };
    } catch {
      // 保留最近一次 moveWindow 写入的位置。
    }
    await persistPosition();
  }, [appWindow, persistPosition]);

  useEffect(() => {
    let disposed = false;
    let activityOff: UnlistenFn | undefined;
    let settingsOff: UnlistenFn | undefined;

    const loadInitial = async () => {
      try {
        const [status, floating, currentPosition] = await Promise.all([
          proxyApi.getProxyStatus(),
          proxyApi.getProxyActivityFloatingSettings(),
          appWindow.outerPosition(),
        ]);
        if (disposed) return;

        const nextCount = status.active_request_count ?? 0;
        countRef.current = nextCount;
        setTargets(
          normalizeActiveRequestTargets(
            status.active_request_targets,
            status.active_request_count,
          ),
        );
        settingsRef.current = floating;
        setSettings(floating);
        setAlwaysOnTop(floating.alwaysOnTop);

        const savedPosition = normalizePosition(floating.position);
        const initialPosition =
          savedPosition ??
          (Number.isFinite(currentPosition.x) &&
          Number.isFinite(currentPosition.y)
            ? { x: currentPosition.x, y: currentPosition.y }
            : { x: 24, y: 24 });

        positionRef.current = initialPosition;
        await resizeWindow();
        await moveWindow(initialPosition);
        await appWindow.setAlwaysOnTop(floating.alwaysOnTop);
        if (floating.mode !== "panel") {
          await proxyApi.setProxyActivityFloatingMode("panel");
        }
        syncRuntimeVisibility(nextCount, floating.visible, nextCount === 0);
      } catch (error) {
        console.debug("初始化实时请求浮窗失败", error);
      }
    };

    void loadInitial();

    (async () => {
      activityOff = await listen<ProxyActivityEvent>(
        "proxy-activity-updated",
        (event) => {
          const payload = event.payload;
          countRef.current = payload.active_request_count;
          setTargets(
            normalizeActiveRequestTargets(
              payload.active_request_targets,
              payload.active_request_count,
            ),
          );
          syncRuntimeVisibility(
            payload.active_request_count,
            settingsRef.current.visible,
          );
        },
      );
      settingsOff = await listen<ProxyActivityFloatingSettings>(
        "proxy-activity-floating-settings-changed",
        (event) => {
          settingsRef.current = event.payload;
          setSettings(event.payload);
          setAlwaysOnTop(event.payload.alwaysOnTop);
          void resizeWindow();
          syncRuntimeVisibility(
            countRef.current,
            event.payload.visible,
            countRef.current === 0,
          );
        },
      );
      if (disposed) {
        activityOff?.();
        settingsOff?.();
      }
    })().catch((error) => console.debug("监听实时请求浮窗事件失败", error));

    return () => {
      disposed = true;
      clearIdleHideTimer();
      activityOff?.();
      settingsOff?.();
    };
  }, [
    appWindow,
    clearIdleHideTimer,
    moveWindow,
    resizeWindow,
    syncRuntimeVisibility,
  ]);

  const onPointerDown = async (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest("[data-floating-action]")) return;

    const surface = event.currentTarget;
    surface.setPointerCapture(event.pointerId);
    try {
      const [position, cursor] = await Promise.all([
        appWindow.outerPosition(),
        readPointerScreenPosition(event),
      ]);
      positionRef.current = { x: position.x, y: position.y };
      dragRef.current = {
        pointerId: event.pointerId,
        startCursor: cursor,
        startWindow: { x: position.x, y: position.y },
        moveSeq: 0,
      };
    } catch (error) {
      if (surface.hasPointerCapture(event.pointerId)) {
        surface.releasePointerCapture(event.pointerId);
      }
      console.debug("开始拖动实时请求浮窗失败", error);
    }
  };

  const onPointerMove = async (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    drag.moveSeq += 1;
    const moveSeq = drag.moveSeq;
    const cursor = await readPointerScreenPosition(event);
    if (dragRef.current !== drag || drag.moveSeq !== moveSeq) return;

    const dx = cursor.x - drag.startCursor.x;
    const dy = cursor.y - drag.startCursor.y;
    try {
      await moveWindow({
        x: drag.startWindow.x + dx,
        y: drag.startWindow.y + dy,
      });
    } catch (error) {
      console.debug("拖动实时请求浮窗失败", error);
    }
  };

  const onPointerUp = async (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    await settlePosition();
  };

  const hide = () => {
    void proxyApi.setProxyActivityFloatingWindowVisible(false);
  };

  const toggleAlwaysOnTop = async () => {
    const next = !alwaysOnTop;
    setAlwaysOnTop(next);
    settingsRef.current = {
      ...settingsRef.current,
      alwaysOnTop: next,
    };
    try {
      await proxyApi.setProxyActivityFloatingAlwaysOnTop(next);
    } catch (error) {
      const reverted = !next;
      setAlwaysOnTop(reverted);
      settingsRef.current = {
        ...settingsRef.current,
        alwaysOnTop: reverted,
      };
      console.debug("切换实时请求浮窗置顶失败", error);
    }
  };

  return (
    <div
      className="h-screen w-screen touch-none select-none overflow-hidden bg-transparent p-px text-white"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <div
        className="group relative flex h-full w-full cursor-grab flex-col overflow-hidden rounded-lg border border-white/20 shadow-2xl backdrop-blur-xl active:cursor-grabbing"
        style={{ backgroundColor: `rgba(24, 24, 27, ${opacity})` }}
      >
        <div className="pointer-events-none absolute right-1.5 top-1.5 z-10 flex items-center gap-1 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100">
          <button
            type="button"
            className={cn(
              "flex h-6 w-6 items-center justify-center rounded-md bg-zinc-950/70 text-white/65 shadow-sm hover:bg-white/15 hover:text-white",
              alwaysOnTop && "text-emerald-200",
            )}
            onClick={() => void toggleAlwaysOnTop()}
            aria-label={alwaysOnTop ? "取消置顶" : "保持最前"}
            title={alwaysOnTop ? "取消置顶" : "保持最前"}
            data-floating-action
          >
            {alwaysOnTop ? (
              <Pin className="h-3.5 w-3.5" />
            ) : (
              <PinOff className="h-3.5 w-3.5" />
            )}
          </button>
          <button
            type="button"
            className="flex h-6 w-6 items-center justify-center rounded-md bg-zinc-950/70 text-white/65 shadow-sm hover:bg-white/15 hover:text-white"
            onClick={hide}
            aria-label="Close"
            title="关闭"
            data-floating-action
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-1.5 [scrollbar-color:rgba(255,255,255,0.32)_transparent] [scrollbar-width:thin]">
          {visibleTargets.length > 0 ? (
            visibleTargets.map((target) => {
              const model = getActivityDisplayModel(target);
              return (
                <div
                  key={`${target.app_type}:${target.provider_id}`}
                  className="mb-1 grid h-8 min-w-0 grid-cols-[3.25rem_minmax(0,1.1fr)_minmax(0,1fr)_auto] items-center gap-1.5 rounded-md bg-white/[0.07] px-1.5 text-[10px] last:mb-0 hover:bg-white/[0.11]"
                  title={targetTitle(target)}
                >
                  <span className="min-w-0 truncate font-semibold uppercase text-emerald-200">
                    {appLabel(target.app_type)}
                  </span>
                  <span className="min-w-0 truncate font-medium text-white">
                    {displayText(target.provider_name)}
                  </span>
                  <span className="min-w-0 truncate font-mono text-white/55">
                    {displayText(model)}
                  </span>
                  <span className="shrink-0 rounded bg-white/10 px-1.5 py-0.5 text-white/75">
                    请求 {target.inflight_requests}
                  </span>
                </div>
              );
            })
          ) : (
            <div className="grid h-8 grid-cols-[3.25rem_minmax(0,1.1fr)_minmax(0,1fr)_auto] items-center gap-1.5 rounded-md border border-dashed border-white/12 px-1.5 text-[10px] text-white/45">
              <span className="font-semibold text-white/60">CODEX</span>
              <span className="truncate">-</span>
              <span className="truncate font-mono">-</span>
              <span className="rounded bg-white/10 px-1.5 py-0.5">请求 0</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
