import React, { type ErrorInfo } from "react";
import ReactDOM from "react-dom/client";
import { message } from "@tauri-apps/plugin-dialog";
import { exit } from "@tauri-apps/plugin-process";
import App from "./App";
import { AppProviders } from "./AppProviders";
import i18n from "./i18n";
import "./index.css";
import { invokeWhenBridgeReady, listenWhenBridgeReady } from "@/lib/tauriBridge";

interface ConfigLoadErrorPayload {
  path?: string;
  error?: string;
}

const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  return String(error ?? "Unknown error");
};

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");

const renderFatalError = (error: unknown) => {
  const root = document.getElementById("root");
  if (!root) return;

  root.innerHTML = `
    <div style="
      display:flex;
      flex-direction:column;
      align-items:center;
      justify-content:center;
      height:100vh;
      background:#f8fafc;
      color:#0f172a;
      font-family:Segoe UI, Arial, sans-serif;
      padding:24px;
      text-align:center;
    ">
      <div style="font-size:16px;font-weight:600;margin-bottom:8px;">
        界面加载失败
      </div>
      <div style="font-size:12px;color:#6b7280;max-width:720px;white-space:pre-wrap;">
        ${escapeHtml(getErrorMessage(error))}
      </div>
    </div>
  `;
};

const handleConfigLoadError = async (
  payload: ConfigLoadErrorPayload | null,
): Promise<void> => {
  const path = payload?.path ?? "~/.cc-switch/config.json";
  const detail = payload?.error ?? "Unknown error";

  await message(
    i18n.t("errors.configLoadFailedMessage", {
      path,
      detail,
      defaultValue:
        "无法读取配置文件：\n{{path}}\n\n错误详情：\n{{detail}}\n\n请手动检查 JSON 是否有效，或从同目录的备份文件（如 config.json.bak）恢复。\n\n应用将退出以便您进行修复。",
    }),
    {
      title: i18n.t("errors.configLoadFailedTitle", {
        defaultValue: "配置加载失败",
      }),
      kind: "error",
    },
  );

  await exit(1);
};

const monitorConfigLoadErrors = async (): Promise<void> => {
  try {
    await listenWhenBridgeReady(
      "configLoadError",
      async (event) => {
        await handleConfigLoadError(
          event.payload as ConfigLoadErrorPayload | null,
        );
      },
      { label: "configLoadError subscription" },
    );
  } catch (error) {
    console.error("订阅 configLoadError 事件失败", error);
  }

  try {
    const initError = await invokeWhenBridgeReady<ConfigLoadErrorPayload | null>(
      "get_init_error",
      undefined,
      { label: "initialization error query" },
    );

    if (initError && (initError.path || initError.error)) {
      await handleConfigLoadError(initError);
    }
  } catch (error) {
    console.error("拉取初始化错误失败", error);
  }
};

const FatalErrorScreen = ({ error }: { error: unknown }) => (
  <div
    style={{
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      height: "100vh",
      background: "#f8fafc",
      color: "#0f172a",
      fontFamily: "Segoe UI, Arial, sans-serif",
      padding: 24,
      textAlign: "center",
    }}
  >
    <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>
      界面加载失败
    </div>
    <div
      style={{
        fontSize: 12,
        color: "#6b7280",
        maxWidth: 720,
        whiteSpace: "pre-wrap",
      }}
    >
      {getErrorMessage(error)}
    </div>
  </div>
);

class AppCrashBoundary extends React.Component<
  { children: React.ReactNode },
  { error: unknown | null }
> {
  state = {
    error: null,
  } as { error: unknown | null };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("[bootstrap] React render crashed", error, errorInfo);
  }

  render() {
    if (this.state.error) {
      return <FatalErrorScreen error={this.state.error} />;
    }

    return this.props.children;
  }
}

try {
  const ua = navigator.userAgent || "";
  const platform = (navigator.platform || "").toLowerCase();
  const isMac = /mac/i.test(ua) || platform.includes("mac");
  if (isMac) {
    document.body.classList.add("is-mac");
  }
} catch {
  // Ignore platform detection failures.
}

window.addEventListener("error", (event) => {
  if (event.error) {
    renderFatalError(event.error);
  } else if (event.message) {
    renderFatalError(event.message);
  }
});

window.addEventListener("unhandledrejection", (event) => {
  renderFatalError(event.reason ?? "Unhandled promise rejection");
});

async function bootstrap() {
  const rootElement = document.getElementById("root");
  if (!rootElement) {
    throw new Error("Root element #root was not found");
  }

  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <AppCrashBoundary>
        <AppProviders>
          <App />
        </AppProviders>
      </AppCrashBoundary>
    </React.StrictMode>,
  );

  void monitorConfigLoadErrors();
}

void bootstrap().catch((error) => {
  renderFatalError(error);
});
