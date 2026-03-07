import { useCallback, useEffect, useRef, useState } from "react";

type ResizeState<K extends string> = {
  key: K;
  startX: number;
  startWidth: number;
};

interface UseColumnResizeOptions<K extends string> {
  initialWidths: Record<K, number>;
  minWidths?: Partial<Record<K, number>>;
}

export function useColumnResize<K extends string>({
  initialWidths,
  minWidths,
}: UseColumnResizeOptions<K>) {
  const [widths, setWidths] = useState<Record<K, number>>(initialWidths);
  const resizingRef = useRef<ResizeState<K> | null>(null);

  const stopResizing = useCallback(() => {
    resizingRef.current = null;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  }, []);

  const handleMouseMove = useCallback(
    (event: MouseEvent) => {
      const state = resizingRef.current;
      if (!state) return;

      const deltaX = event.clientX - state.startX;
      const minWidth = minWidths?.[state.key] ?? 72;
      const nextWidth = Math.max(minWidth, state.startWidth + deltaX);

      setWidths((previous) => ({
        ...previous,
        [state.key]: nextWidth,
      }));
    },
    [minWidths],
  );

  useEffect(() => {
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", stopResizing);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", stopResizing);
    };
  }, [handleMouseMove, stopResizing]);

  const startResize = useCallback(
    (key: K, event: React.MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      resizingRef.current = {
        key,
        startX: event.clientX,
        startWidth: widths[key],
      };
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [widths],
  );

  return {
    widths,
    setWidths,
    startResize,
    stopResizing,
  };
}
