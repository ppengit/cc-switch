import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity, ChevronLeft, ChevronRight, Minus, X } from "lucide-react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  availableMonitors,
  getCurrentWindow,
  PhysicalPosition,
  PhysicalSize,
  type Monitor,
} from "@tauri-apps/api/window";
import { proxyApi } from "@/lib/api/proxy";
import type {
  ActiveRequestTarget,
  ProxyActivityEvent,
  ProxyActivityFloatingSettings,
} from "@/types/proxy";
import {
  getActivityDisplayModel,
  normalizeActiveRequestTargets,
} from "@/lib/proxyActivity";
import { cn } from "@/lib/utils";
import "@/i18n";

const BALL_SIZE = 64;
const PANEL_WIDTH = 292;
const PANEL_HEIGHT = 144;
const VISIBLE_SLIVER = 10;
const EDGE_THRESHOLD = 28;
const DEFAULT_MARGIN = 24;

type Edge = "left" | "right" | "top" | "bottom";

type WindowMode = "ball" | "panel";

interface Point {
  x: number;
  y: number;
}

interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

function monitorBounds(monitor: Monitor): Bounds {
  return {
    x: monitor.workArea.position.x,
    y: monitor.workArea.position.y,
    width: monitor.workArea.size.width,
    height: monitor.workArea.size.height,
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function providerInitial(name?: string | null) {
  const trimmed = (name || "").trim();
  return trimmed ? trimmed.slice(0, 1).toUpperCase() : "-";
}

function compactSession(sessionId?: string | null) {
  const trimmed = (sessionId || "").trim();
  if (!trimmed) return undefined;
  if (trimmed.length <= 10) return trimmed;
  return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
}

function projectLabel(target?: ActiveRequestTarget) {
  const explicit = target?.project_name?.trim();
  if (explicit) return explicit;

  const path = target?.project_path?.trim();
  if (!path) return undefined;
  return (
    path
      .split(/[\\/]+/)
      .filter(Boolean)
      .pop() || path
  );
}

function targetTitle(target: ActiveRequestTarget) {
  const model = getActivityDisplayModel(target);
  const project = projectLabel(target);
  const parts = [
    project,
    target.provider_name,
    model,
    compactSession(target.session_id),
  ].filter(Boolean);
  return parts.join(" · ");
}

function nearestMonitor(monitors: Monitor[], point: Point): Monitor | undefined {
  if (!monitors.length) return undefined;

  const containing = monitors.find((monitor) => {
    const bounds = monitorBounds(monitor);
    return (
      point.x >= bounds.x &&
      point.x <= bounds.x + bounds.width &&
      point.y >= bounds.y &&
      point.y <= bounds.y + bounds.height
    );
  });
  if (containing) return containing;

  return monitors
    .map((monitor) => {
      const bounds = monitorBounds(monitor);
      const cx = bounds.x + bounds.width / 2;
      const cy = bounds.y + bounds.height / 2;
      return {
        monitor,
        distance: Math.hypot(point.x - cx, point.y - cy),
      };
    })
    .sort((a, b) => a.distance - b.distance)[0]?.monitor;
}

function snapEdge(bounds: Bounds, pos: Point, size: Point): Edge {
  const distances: Array<[Edge, number]> = [
    ["left", Math.abs(pos.x - bounds.x)],
    ["right", Math.abs(bounds.x + bounds.width - (pos.x + size.x))],
    ["top", Math.abs(pos.y - bounds.y)],
    ["bottom", Math.abs(bounds.y + bounds.height - (pos.y + size.y))],
  ];
  distances.sort((a, b) => a[1] - b[1]);
  return distances[0]?.[0] ?? "right";
}

function visiblePosition(edge: Edge, bounds: Bounds, pos: Point, size: Point): Point {
  switch (edge) {
    case "left":
      return {
        x: bounds.x,
        y: clamp(pos.y, bounds.y, bounds.y + bounds.height - size.y),
      };
    case "right":
      return {
        x: bounds.x + bounds.width - size.x,
        y: clamp(pos.y, bounds.y, bounds.y + bounds.height - size.y),
      };
    case "top":
      return {
        x: clamp(pos.x, bounds.x, bounds.x + bounds.width - size.x),
        y: bounds.y,
      };
    case "bottom":
      return {
        x: clamp(pos.x, bounds.x, bounds.x + bounds.width - size.x),
        y: bounds.y + bounds.height - size.y,
      };
  }
}

function tuckedPosition(edge: Edge, visible: Point, size: Point): Point {
  switch (edge) {
    case "left":
      return { ...visible, x: visible.x - size.x + VISIBLE_SLIVER };
    case "right":
      return { ...visible, x: visible.x + size.x - VISIBLE_SLIVER };
    case "top":
      return { ...visible, y: visible.y - size.y + VISIBLE_SLIVER };
    case "bottom":
      return { ...visible, y: visible.y + size.y - VISIBLE_SLIVER };
  }
}

function shouldSnap(bounds: Bounds, pos: Point, size: Point) {
  return (
    Math.abs(pos.x - bounds.x) <= EDGE_THRESHOLD ||
    Math.abs(bounds.x + bounds.width - (pos.x + size.x)) <= EDGE_THRESHOLD ||
    Math.abs(pos.y - bounds.y) <= EDGE_THRESHOLD ||
    Math.abs(bounds.y + bounds.height - (pos.y + size.y)) <= EDGE_THRESHOLD
  );
}

export function ProxyActivityFloatingWindow() {
  const appWindow = useMemo(() => getCurrentWindow(), []);
  const [count, setCount] = useState(0);
  const [targets, setTargets] = useState<ActiveRequestTarget[]>([]);
  const [settings, setSettings] = useState<ProxyActivityFloatingSettings>({
    visible: true,
    opacity: 0.86,
  });
  const [mode, setMode] = useState<WindowMode>("ball");
  const [tucked, setTucked] = useState(false);
  const [edge, setEdge] = useState<Edge>("right");
  const dragRef = useRef<{
    pointerId: number;
    startClient: Point;
    startWindow: Point;
    moved: boolean;
  } | null>(null);
  const positionRef = useRef<Point>({ x: 0, y: 0 });
  const sizeRef = useRef<Point>({ x: BALL_SIZE, y: BALL_SIZE });
  const edgeRef = useRef<Edge>("right");

  const visibleTargets = useMemo(() => targets.slice(0, 3), [targets]);
  const primaryTarget = visibleTargets[0];
  const primaryProject = projectLabel(primaryTarget);
  const primaryModel = primaryTarget ? getActivityDisplayModel(primaryTarget) : undefined;
  const opacity = Math.min(1, Math.max(0.35, settings.opacity || 0.86));
  const busy = count > 0;
  const isPanel = mode === "panel";

  const getContext = useCallback(
    async (size = sizeRef.current) => {
      const monitors = await availableMonitors();
      const center = {
        x: positionRef.current.x + size.x / 2,
        y: positionRef.current.y + size.y / 2,
      };
      const monitor = nearestMonitor(monitors, center) ?? monitors[0];
      const bounds = monitor
        ? monitorBounds(monitor)
        : { x: 0, y: 0, width: 1280, height: 720 };
      return { bounds };
    },
    [],
  );

  const moveWindow = useCallback(
    async (pos: Point) => {
      positionRef.current = pos;
      await appWindow.setPosition(new PhysicalPosition(Math.round(pos.x), Math.round(pos.y)));
    },
    [appWindow],
  );

  const resizeWindow = useCallback(
    async (size: Point) => {
      sizeRef.current = size;
      await appWindow.setSize(new PhysicalSize(Math.round(size.x), Math.round(size.y)));
    },
    [appWindow],
  );

  const applySnap = useCallback(
    async (forceTuck: boolean) => {
      const size = sizeRef.current;
      const { bounds } = await getContext(size);
      const current = positionRef.current;
      const nextEdge = snapEdge(bounds, current, size);
      edgeRef.current = nextEdge;
      setEdge(nextEdge);

      const visible = visiblePosition(nextEdge, bounds, current, size);
      const next = forceTuck ? tuckedPosition(nextEdge, visible, size) : visible;
      setTucked(forceTuck);
      await moveWindow(next);
    },
    [getContext, moveWindow],
  );

  const setFloatingMode = useCallback(
    async (nextMode: WindowMode, keepVisible = true) => {
      setMode(nextMode);
      const nextSize =
        nextMode === "panel"
          ? { x: PANEL_WIDTH, y: PANEL_HEIGHT }
          : { x: BALL_SIZE, y: BALL_SIZE };
      const previous = positionRef.current;
      await resizeWindow(nextSize);
      const { bounds } = await getContext(nextSize);
      const currentEdge = edgeRef.current;
      const visible = visiblePosition(currentEdge, bounds, previous, nextSize);
      const next = keepVisible ? visible : tuckedPosition(currentEdge, visible, nextSize);
      setTucked(!keepVisible);
      await moveWindow(next);
    },
    [getContext, moveWindow, resizeWindow],
  );

  useEffect(() => {
    let disposed = false;
    let activityOff: UnlistenFn | undefined;
    let settingsOff: UnlistenFn | undefined;

    const loadInitial = async () => {
      try {
        const [status, floating, position] = await Promise.all([
          proxyApi.getProxyStatus(),
          proxyApi.getProxyActivityFloatingSettings(),
          appWindow.outerPosition(),
        ]);
        if (disposed) return;
        positionRef.current = { x: position.x, y: position.y };
        setCount(status.active_request_count ?? 0);
        setTargets(
          normalizeActiveRequestTargets(
            status.active_request_targets,
            status.active_request_count,
          ),
        );
        setSettings(floating);
        await resizeWindow({ x: BALL_SIZE, y: BALL_SIZE });
        const { bounds } = await getContext({ x: BALL_SIZE, y: BALL_SIZE });
        const defaultPos = {
          x: bounds.x + bounds.width - BALL_SIZE - DEFAULT_MARGIN,
          y: bounds.y + bounds.height - BALL_SIZE - DEFAULT_MARGIN,
        };
        positionRef.current = defaultPos;
        await moveWindow(defaultPos);
      } catch {
        // 浮窗不显示错误弹窗，避免小窗抢焦点。
      }
    };

    void loadInitial();

    (async () => {
      activityOff = await listen<ProxyActivityEvent>(
        "proxy-activity-updated",
        (event) => {
          const payload = event.payload;
          setCount(payload.active_request_count);
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
        (event) => setSettings(event.payload),
      );
      if (disposed) {
        activityOff?.();
        settingsOff?.();
      }
    })();

    return () => {
      disposed = true;
      activityOff?.();
      settingsOff?.();
    };
  }, [appWindow, getContext, moveWindow, resizeWindow]);

  const onPointerDown = async (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest("[data-floating-action]")) return;

    if (tucked) {
      setTucked(false);
      await applySnap(false);
    }

    const position = await appWindow.outerPosition();
    positionRef.current = { x: position.x, y: position.y };
    dragRef.current = {
      pointerId: event.pointerId,
      startClient: { x: event.clientX, y: event.clientY },
      startWindow: { x: position.x, y: position.y },
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = async (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    const dx = event.clientX - drag.startClient.x;
    const dy = event.clientY - drag.startClient.y;
    if (Math.hypot(dx, dy) > 3) {
      drag.moved = true;
    }

    await moveWindow({
      x: drag.startWindow.x + dx,
      y: drag.startWindow.y + dy,
    });
  };

  const onPointerUp = async (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);

    const size = sizeRef.current;
    const { bounds } = await getContext(size);
    const shouldTuck = shouldSnap(bounds, positionRef.current, size);
    await applySnap(shouldTuck && mode === "ball");

    if (!drag.moved) {
      await setFloatingMode(mode === "panel" ? "ball" : "panel", true);
    }
  };

  const reveal = async () => {
    if (tucked) {
      await applySnap(false);
    }
  };

  const hide = () => {
    void proxyApi.setProxyActivityFloatingWindowVisible(false);
  };

  const collapse = () => {
    void setFloatingMode("ball", true);
  };

  const tuck = () => {
    void setFloatingMode("ball", false);
  };

  return (
    <div
      className="flex min-h-screen select-none items-center justify-center bg-transparent text-white"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onMouseEnter={reveal}
    >
      {isPanel ? (
        <div
          className="h-[128px] w-[276px] rounded-lg border border-white/15 px-3 py-2 shadow-2xl backdrop-blur-xl"
          style={{ backgroundColor: `rgba(24, 24, 27, ${opacity})` }}
        >
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <div
                className={cn(
                  "flex h-8 w-8 shrink-0 items-center justify-center rounded-md",
                  busy ? "bg-emerald-500/20" : "bg-white/10",
                )}
              >
                <Activity
                  className={cn(
                    "h-4 w-4",
                    busy && "animate-pulse text-emerald-300",
                  )}
                />
              </div>
              <div className="min-w-0">
                <div className="flex items-baseline gap-1">
                  <span className="text-2xl font-semibold leading-none">
                    {count}
                  </span>
                  <span className="text-[11px] text-white/60">requests</span>
                </div>
                <div className="truncate text-[11px] text-white/55">
                  {primaryProject || primaryModel || (busy ? "processing" : "idle")}
                </div>
              </div>
            </div>
            <div className="flex gap-1" data-floating-action>
              <button
                type="button"
                className="flex h-6 w-6 items-center justify-center rounded-md text-white/60 hover:bg-white/10 hover:text-white"
                onClick={tuck}
                aria-label="Dock"
              >
                {edge === "left" ? (
                  <ChevronLeft className="h-3.5 w-3.5" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5" />
                )}
              </button>
              <button
                type="button"
                className="flex h-6 w-6 items-center justify-center rounded-md text-white/60 hover:bg-white/10 hover:text-white"
                onClick={collapse}
                aria-label="Collapse"
              >
                <Minus className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                className="flex h-6 w-6 items-center justify-center rounded-md text-white/60 hover:bg-white/10 hover:text-white"
                onClick={hide}
                aria-label="Close"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          <div className="mt-2 grid grid-cols-3 gap-1.5">
            {visibleTargets.length > 0
              ? visibleTargets.map((target) => {
                  const project = projectLabel(target);
                  const model = getActivityDisplayModel(target);
                  return (
                    <div
                      key={`${target.app_type}:${target.provider_id}`}
                      className="min-w-0 rounded-md bg-white/8 px-2 py-1"
                      title={targetTitle(target)}
                    >
                      <div className="flex items-center justify-between gap-1">
                        <span className="text-[10px] uppercase text-white/50">
                          {target.app_type}
                        </span>
                        <span className="text-[10px] text-emerald-200">
                          {target.inflight_requests}
                        </span>
                      </div>
                      <div className="truncate text-[11px] font-medium">
                        {project || `${providerInitial(target.provider_name)} ${target.provider_name}`}
                      </div>
                      <div className="truncate text-[10px] text-white/45">
                        {model || target.provider_name}
                      </div>
                    </div>
                  );
                })
              : [0, 1, 2].map((index) => (
                  <div
                    key={index}
                    className="h-11 rounded-md border border-dashed border-white/10"
                  />
                ))}
          </div>
        </div>
      ) : (
        <div
          className={cn(
            "relative flex h-14 w-14 items-center justify-center rounded-full border shadow-2xl backdrop-blur-xl",
            busy
              ? "border-emerald-300/35 bg-emerald-950"
              : "border-white/15 bg-zinc-950",
          )}
          style={{ backgroundColor: `rgba(24, 24, 27, ${opacity})` }}
          title={primaryProject || primaryModel || "CC Switch requests"}
        >
          <Activity
            className={cn("h-5 w-5 text-white/75", busy && "animate-pulse text-emerald-300")}
          />
          <span className="absolute -right-0.5 -top-0.5 flex h-6 min-w-6 items-center justify-center rounded-full bg-emerald-500 px-1 text-[11px] font-semibold text-white shadow-lg">
            {count > 99 ? "99+" : count}
          </span>
          {primaryProject ? (
            <span className="absolute bottom-1 max-w-[42px] truncate text-[9px] text-white/55">
              {primaryProject}
            </span>
          ) : null}
        </div>
      )}
    </div>
  );
}
