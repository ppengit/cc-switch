import { Toaster as SonnerToaster } from "sonner";
import { useTheme } from "@/components/theme-provider";

export function Toaster() {
  const { theme } = useTheme();

  // 将应用主题映射到 Sonner 的主题
  // 如果是 "system"，Sonner 会自己处理
  const sonnerTheme = theme === "system" ? "system" : theme;

  return (
    <SonnerToaster
      position="bottom-center"
      theme={sonnerTheme}
      toastOptions={{
        duration: 2400,
        classNames: {
          toast:
            "group w-[min(640px,calc(100vw-1.5rem))] rounded-2xl border border-border/70 bg-background/90 px-4 py-3 text-foreground shadow-[0_22px_60px_-34px_rgba(15,23,42,0.48)] backdrop-blur-xl",
          title: "text-sm font-semibold tracking-tight",
          description: "text-sm text-muted-foreground",
          closeButton:
            "absolute right-3 top-3 rounded-full border border-border/70 bg-background/80 p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
          actionButton:
            "rounded-full border border-border/70 bg-background px-3 py-1 text-xs font-medium text-foreground transition-colors hover:bg-muted",
        },
      }}
    />
  );
}
