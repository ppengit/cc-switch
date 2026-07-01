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
  ProxyActivityFloatingSize,
} from "@/types/proxy";
import {
  getActivityDisplayModel,
  normalizeActiveRequestTargets,
} from "@/lib/proxyActivity";
import { ClaudeIcon, CodexIcon } from "@/components/BrandIcons";
import { cn } from "@/lib/utils";
import "@/i18n";

// 默认尺寸：物理像素。高度按 4 行 + 紧凑边距计算。
const DEFAULT_WIDTH = 312;
const DEFAULT_HEIGHT = 168;
const MIN_WIDTH = 220;
const MIN_HEIGHT = 96;
const MAX_WIDTH = 640;
const MAX_HEIGHT = 720;
const ROW_HEIGHT = 30;

interface Point {
  x: number;
  y: number;
}

type Drag =
  | {
      kind: "move";
      pointerId: number;
      startCursor: Point;
      startWindow: Point;
      moveSeq: number;
    }
  | {
      kind: "resize";
      pointerId: number;
      startCursor: Point;
      startSize: { width: number; height: number };
      moveSeq: number;
    };

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

function normalizeSize(size?: ProxyActivityFloatingSize | null): {
  width: number;
  height: number;
} {
  const width = size?.width;
  const height = size?.height;
  return {
    width:
      Number.isFinite(width) && width! >= MIN_WIDTH
        ? Math.min(MAX_WIDTH, Math.round(width!))
        : DEFAULT_WIDTH,
    height:
      Number.isFinite(height) && height! >= MIN_HEIGHT
        ? Math.min(MAX_HEIGHT, Math.round(height!))
        : DEFAULT_HEIGHT,
  };
}

function displayText(value?: string | null) {
  const trimmed = (value || "").trim();
  return trimmed || "-";
}

function appIcon(appType?: string | null) {
  const normalized = (appType || "codex").trim().toLowerCase();
  if (normalized.startsWith("claude")) {
    return <ClaudeIcon size={14} />;
  }
  return <CodexIcon size={14} />;
}

function appAlt(appType?: string | null) {
  const normalized = (appType || "codex").trim().toLowerCase();
  return normalized.startsWith("claude") ? "Claude" : "Codex";
}

function targetTitle(target: ActiveRequestTarget) {
  return [
    appAlt(target.app_type),
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

function clampSize(width: number, height: number) {
  return {
    width: Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(width))),
    height: Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.round(height))),
  };
}

export function ProxyActivityFloatingWindow() {
  const appWindow = useMemo(() => getCurrentWindow(), []);
  const [targets, setTargets] = useState<ActiveRequestTarget[]>([]);
  const [alwaysOnTop, setAlwaysOnTop] = useState(true);
  const [settings, setSettings] = useState<ProxyActivityFloatingSettings>({
    visible: true,
    opacity: 0.86,
    idleHideSeconds: 180,
    alwaysOnTop: true,
    mode: "panel",
    position: null,
    size: null,
  });
  const [size, setSize] = useState({
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
  });
  const dragRef = useRef<Drag | null>(null);
  const countRef = useRef(0);
  const settingsRef = useRef(settings);
  const sizeRef = useRef(size);
  const positionRef = useRef<Point>({ x: 0, y: 0 });

  const visibleTargets = useMemo(() => targets, [targets]);
  const opacity = Math.min(1, Math.max(0.35, settings.opacity || 0.86));

  const moveWindow = useCallback(
    async (pos: Point) => {
      positionRef.current = pos;
      await appWindow.setPosition(
        new PhysicalPosition(Math.round(pos.x), Math.round(pos.y)),
      );
    },
    [appWindow],
  );

  const applySize = useCallback(
    async (next: { width: number; height: number }) => {
      sizeRef.current = next;
      setSize(next);
      await appWindow.setSize(new PhysicalSize(next.width, next.height));
    },
    [appWindow],
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

  const persistSize = useCallback(async (next = sizeRef.current) => {
    try {
      await proxyApi.setProxyActivityFloatingSize({
        width: next.width,
        height: next.height,
      });
    } catch (error) {
      console.debug("保存实时请求浮窗尺寸失败", error);
    }
  }, []);

  const syncVisibility = useCallback(
    (enabled: boolean) => {
      if (!enabled) return;
      void appWindow
        .show()
        .then(() => appWindow.setAlwaysOnTop(settingsRef.current.alwaysOnTop))
        .catch((error) => console.debug("显示实时请求浮窗失败", error));
    },
    [appWindow],
  );

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

        const initialSize = normalizeSize(floating.size);
        sizeRef.current = initialSize;
        setSize(initialSize);

        const savedPosition = normalizePosition(floating.position);
        const initialPosition =
          savedPosition ??
          (Number.isFinite(currentPosition.x) &&
          Number.isFinite(currentPosition.y)
            ? { x: currentPosition.x, y: currentPosition.y }
            : { x: 24, y: 24 });

        positionRef.current = initialPosition;
        await applySize(initialSize);
        await moveWindow(initialPosition);
        await appWindow.setAlwaysOnTop(floating.alwaysOnTop);
        if (floating.mode !== "panel") {
          await proxyApi.setProxyActivityFloatingMode("panel");
        }
        syncVisibility(floating.visible);
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
        },
      );
      settingsOff = await listen<ProxyActivityFloatingSettings>(
        "proxy-activity-floating-settings-changed",
        (event) => {
          settingsRef.current = event.payload;
          setSettings(event.payload);
          setAlwaysOnTop(event.payload.alwaysOnTop);
          const next = normalizeSize(event.payload.size);
          if (
            next.width !== sizeRef.current.width ||
            next.height !== sizeRef.current.height
          ) {
            void applySize(next);
          }
          syncVisibility(event.payload.visible);
        },
      );
      if (disposed) {
        activityOff?.();
        settingsOff?.();
      }
    })().catch((error) => console.debug("监听实时请求浮窗事件失败", error));

    return () => {
      disposed = true;
      activityOff?.();
      settingsOff?.();
    };
  }, [appWindow, applySize, moveWindow, syncVisibility]);

  const onMovePointerDown = async (
    event: React.PointerEvent<HTMLDivElement>,
  ) => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    // 缩放手柄单独处理，其它交互控件（图钉/关闭）不触发拖动。
    const surface = event.currentTarget;

    if (target.closest("[data-resize-handle]")) {
      surface.setPointerCapture(event.pointerId);
      try {
        const cursor = await readPointerScreenPosition(event);
        dragRef.current = {
          kind: "resize",
          pointerId: event.pointerId,
          startCursor: cursor,
          startSize: { ...sizeRef.current },
          moveSeq: 0,
        };
      } catch (error) {
        if (surface.hasPointerCapture(event.pointerId)) {
          surface.releasePointerCapture(event.pointerId);
        }
        console.debug("开始调整实时请求浮窗尺寸失败", error);
      }
      return;
    }

    if (target.closest("[data-floating-action]")) return;

    surface.setPointerCapture(event.pointerId);
    try {
      const [position, cursor] = await Promise.all([
        appWindow.outerPosition(),
        readPointerScreenPosition(event),
      ]);
      positionRef.current = { x: position.x, y: position.y };
      dragRef.current = {
        kind: "move",
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

  const onMovePointerMove = async (
    event: React.PointerEvent<HTMLDivElement>,
  ) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    drag.moveSeq += 1;
    const moveSeq = drag.moveSeq;
    const cursor = await readPointerScreenPosition(event);
    if (dragRef.current !== drag || drag.moveSeq !== moveSeq) return;

    if (drag.kind === "move") {
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
      return;
    }

    const dx = cursor.x - drag.startCursor.x;
    const dy = cursor.y - drag.startCursor.y;
    const next = clampSize(
      drag.startSize.width + dx,
      drag.startSize.height + dy,
    );
    try {
      await applySize(next);
    } catch (error) {
      console.debug("调整实时请求浮窗尺寸失败", error);
    }
  };

  const onMovePointerUp = async (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (drag.kind === "move") {
      await settlePosition();
    } else {
      await persistSize();
    }
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
      className="h-screen w-screen touch-none select-none overflow-hidden bg-transparent text-white"
      onPointerDown={onMovePointerDown}
      onPointerMove={onMovePointerMove}
      onPointerUp={onMovePointerUp}
      onPointerCancel={onMovePointerUp}
    >
      <div
        className="group relative flex h-full w-full cursor-grab flex-col overflow-hidden rounded-lg border border-white/20 shadow-2xl backdrop-blur-xl active:cursor-grabbing"
        style={{ backgroundColor: `rgba(24, 24, 27, ${opacity})` }}
      >
        <div className="pointer-events-none absolute right-1 top-1 z-10 flex items-center gap-1 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100">
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

        <div
          className="min-h-0 flex-1 overflow-y-auto p-1 [scrollbar-color:rgba(255,255,255,0.32)_transparent] [scrollbar-width:thin]"
          style={{ maxHeight: size.height - 6 }}
        >
          {visibleTargets.length > 0 ? (
            visibleTargets.map((target) => {
              const model = getActivityDisplayModel(target);
              return (
                <div
                  key={`${target.app_type}:${target.provider_id}`}
                  className="mb-px grid h-[28px] min-w-0 grid-cols-[1.25rem_minmax(0,auto)_minmax(0,1fr)_auto] items-center gap-1.5 rounded-md bg-white/[0.07] px-1.5 text-[10px] last:mb-0 hover:bg-white/[0.11]"
                  style={{ height: ROW_HEIGHT - 2 }}
                  title={targetTitle(target)}
                >
                  <span className="flex min-w-0 items-center justify-center text-emerald-200">
                    {appIcon(target.app_type)}
                  </span>
                  <span className="min-w-0 truncate font-medium text-white">
                    {displayText(target.provider_name)}
                  </span>
                  <span className="min-w-0 truncate font-mono text-white/55">
                    {displayText(model)}
                  </span>
                  <span className="shrink-0 rounded bg-white/10 px-1.5 py-0.5 text-white/75">
                    {target.inflight_requests}
                  </span>
                </div>
              );
            })
          ) : (
            <div
              className="grid min-w-0 grid-cols-[1.25rem_minmax(0,auto)_minmax(0,1fr)_auto] items-center gap-1.5 rounded-md border border-dashed border-white/12 px-1.5 text-[10px] text-white/45"
              style={{ height: ROW_HEIGHT - 2 }}
            >
              <span className="flex items-center justify-center text-white/60">
                {appIcon("codex")}
              </span>
              <span className="truncate">-</span>
              <span className="truncate font-mono">-</span>
              <span className="rounded bg-white/10 px-1.5 py-0.5">0</span>
            </div>
          )}
        </div>

        <div
          className="absolute bottom-0 right-0 z-10 flex h-3.5 w-3.5 cursor-se-resize items-center justify-end"
          data-resize-handle
          data-floating-action
          title="拖拽调整大小"
          aria-label="拖拽调整大小"
        >
          <span className="pointer-events-none block h-2 w-2 rotate-45 border-b border-r border-white/50" />
        </div>
      </div>
    </div>
  );
}
