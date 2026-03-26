import { useState, type ReactNode } from "react";
import {
  Activity,
  FlaskConical,
  Globe,
  ListOrdered,
  Server,
  ShieldAlert,
  Target,
  Zap,
} from "lucide-react";
import { motion } from "framer-motion";
import { useTranslation } from "react-i18next";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { ProxyPanel } from "@/components/proxy";
import { AutoFailoverConfigPanel } from "@/components/proxy/AutoFailoverConfigPanel";
import { FailoverQueueManager } from "@/components/proxy/FailoverQueueManager";
import { ForceModelPanel } from "@/components/proxy/ForceModelPanel";
import { ZeroTokenConfigPanel } from "@/components/proxy/ZeroTokenConfigPanel";
import { RectifierConfigPanel } from "@/components/settings/RectifierConfigPanel";
import { GlobalProxySettings } from "@/components/settings/GlobalProxySettings";
import { ModelTestConfigPanel } from "@/components/usage/ModelTestConfigPanel";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useProxyStatus } from "@/hooks/useProxyStatus";
import type { SettingsFormState } from "@/hooks/useSettings";

interface ProxyTabContentProps {
  settings: SettingsFormState;
  onAutoSave: (updates: Partial<SettingsFormState>) => Promise<void>;
}

const PROXY_APP_TABS = [
  { value: "claude", label: "Claude" },
  { value: "codex", label: "Codex" },
  { value: "gemini", label: "Gemini" },
] as const;

function ProxyAppTabs({
  children,
}: {
  children: (appType: "claude" | "codex" | "gemini") => ReactNode;
}) {
  return (
    <Tabs defaultValue="claude" className="w-full">
      <TabsList className="grid w-full grid-cols-3">
        {PROXY_APP_TABS.map((tab) => (
          <TabsTrigger key={tab.value} value={tab.value}>
            {tab.label}
          </TabsTrigger>
        ))}
      </TabsList>

      {PROXY_APP_TABS.map((tab) => (
        <TabsContent key={tab.value} value={tab.value} className="mt-4">
          {children(tab.value)}
        </TabsContent>
      ))}
    </Tabs>
  );
}

function ProxyRunningNotice({ message }: { message: string }) {
  return (
    <div className="rounded-lg border border-yellow-500/20 bg-yellow-500/10 p-4">
      <p className="text-sm text-yellow-600 dark:text-yellow-400">{message}</p>
    </div>
  );
}

export function ProxyTabContent({
  settings,
  onAutoSave,
}: ProxyTabContentProps) {
  const { t } = useTranslation();
  const [showProxyConfirm, setShowProxyConfirm] = useState(false);

  const {
    isRunning,
    startProxyServer,
    stopWithRestore,
    isPending: isProxyPending,
  } = useProxyStatus();

  const handleToggleProxy = async (checked: boolean) => {
    try {
      if (!checked) {
        await stopWithRestore();
      } else if (!settings?.proxyConfirmed) {
        setShowProxyConfirm(true);
      } else {
        await startProxyServer();
      }
    } catch (error) {
      console.error("Toggle proxy failed:", error);
    }
  };

  const handleProxyConfirm = async () => {
    setShowProxyConfirm(false);
    try {
      await onAutoSave({ proxyConfirmed: true });
      await startProxyServer();
    } catch (error) {
      console.error("Proxy confirm failed:", error);
    }
  };

  const proxyRequiredMessage = t("proxy.settings.proxyRequired", {
    defaultValue: "需要先启动代理服务才能修改当前代理相关配置",
  });

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="space-y-4"
    >
      <Accordion type="multiple" defaultValue={[]} className="w-full space-y-4">
        <AccordionItem
          value="proxy"
          className="rounded-xl glass-card overflow-hidden"
        >
          <AccordionTrigger className="px-6 py-4 hover:no-underline hover:bg-muted/50 data-[state=open]:bg-muted/50">
            <div className="flex items-center gap-3">
              <Server className="h-5 w-5 text-green-500" />
              <div className="text-left">
                <h3 className="text-base font-semibold">
                  {t("settings.advanced.proxy.title")}
                </h3>
                <p className="text-sm text-muted-foreground font-normal">
                  {t("settings.advanced.proxy.description")}
                </p>
              </div>
              <Badge
                variant={isRunning ? "default" : "secondary"}
                className="ml-auto mr-2 h-6 gap-1.5"
              >
                <Activity
                  className={`h-3 w-3 ${isRunning ? "animate-pulse" : ""}`}
                />
                {isRunning
                  ? t("settings.advanced.proxy.running")
                  : t("settings.advanced.proxy.stopped")}
              </Badge>
            </div>
          </AccordionTrigger>
          <AccordionContent className="border-t border-border/50 px-6 pb-6 pt-4">
            <ProxyPanel
              enableLocalProxy={settings?.enableLocalProxy ?? false}
              onEnableLocalProxyChange={(checked) =>
                onAutoSave({ enableLocalProxy: checked })
              }
              onToggleProxy={handleToggleProxy}
              isProxyPending={isProxyPending}
            />
          </AccordionContent>
        </AccordionItem>

        <AccordionItem
          value="failover"
          className="rounded-xl glass-card overflow-hidden"
        >
          <AccordionTrigger className="px-6 py-4 hover:no-underline hover:bg-muted/50 data-[state=open]:bg-muted/50">
            <div className="flex items-center gap-3">
              <Activity className="h-5 w-5 text-orange-500" />
              <div className="text-left">
                <h3 className="text-base font-semibold">
                  {t("settings.advanced.failover.title")}
                </h3>
                <p className="text-sm text-muted-foreground font-normal">
                  {t("settings.advanced.failover.description")}
                </p>
              </div>
            </div>
          </AccordionTrigger>
          <AccordionContent className="border-t border-border/50 px-6 pb-6 pt-4">
            <div className="space-y-6">
              {!isRunning && (
                <ProxyRunningNotice message={proxyRequiredMessage} />
              )}
              <ProxyAppTabs>
                {(appType) => (
                  <AutoFailoverConfigPanel
                    appType={appType}
                    disabled={!isRunning}
                  />
                )}
              </ProxyAppTabs>
            </div>
          </AccordionContent>
        </AccordionItem>

        <AccordionItem
          value="failoverQueue"
          className="rounded-xl glass-card overflow-hidden"
        >
          <AccordionTrigger className="px-6 py-4 hover:no-underline hover:bg-muted/50 data-[state=open]:bg-muted/50">
            <div className="flex items-center gap-3">
              <ListOrdered className="h-5 w-5 text-amber-500" />
              <div className="text-left">
                <h3 className="text-base font-semibold">
                  {t("proxy.failoverQueue.title", {
                    defaultValue: "故障转移队列",
                  })}
                </h3>
                <p className="text-sm text-muted-foreground font-normal">
                  {t("proxy.failoverQueue.description", {
                    defaultValue: "管理各应用的供应商故障转移顺序",
                  })}
                </p>
              </div>
            </div>
          </AccordionTrigger>
          <AccordionContent className="border-t border-border/50 px-6 pb-6 pt-4">
            <div className="space-y-6">
              {!isRunning && (
                <ProxyRunningNotice message={proxyRequiredMessage} />
              )}
              <ProxyAppTabs>
                {(appType) => (
                  <FailoverQueueManager
                    appType={appType}
                    disabled={!isRunning}
                  />
                )}
              </ProxyAppTabs>
            </div>
          </AccordionContent>
        </AccordionItem>

        <AccordionItem
          value="forceModel"
          className="rounded-xl glass-card overflow-hidden"
        >
          <AccordionTrigger className="px-6 py-4 hover:no-underline hover:bg-muted/50 data-[state=open]:bg-muted/50">
            <div className="flex items-center gap-3">
              <Target className="h-5 w-5 text-rose-500" />
              <div className="text-left">
                <h3 className="text-base font-semibold">
                  {t("settings.advanced.forceModel.title", {
                    defaultValue: "强制模型",
                  })}
                </h3>
                <p className="text-sm text-muted-foreground font-normal">
                  {t("settings.advanced.forceModel.description", {
                    defaultValue:
                      "单独控制各应用经过本地代理时的模型改写策略。",
                  })}
                </p>
              </div>
            </div>
          </AccordionTrigger>
          <AccordionContent className="border-t border-border/50 px-6 pb-6 pt-4">
            <div className="space-y-6">
              {!isRunning && (
                <ProxyRunningNotice message={proxyRequiredMessage} />
              )}
              <ProxyAppTabs>
                {(appType) => (
                  <ForceModelPanel appType={appType} disabled={!isRunning} />
                )}
              </ProxyAppTabs>
            </div>
          </AccordionContent>
        </AccordionItem>

        <AccordionItem
          value="zeroToken"
          className="rounded-xl glass-card overflow-hidden"
        >
          <AccordionTrigger className="px-6 py-4 hover:no-underline hover:bg-muted/50 data-[state=open]:bg-muted/50">
            <div className="flex items-center gap-3">
              <ShieldAlert className="h-5 w-5 text-yellow-500" />
              <div className="text-left">
                <h3 className="text-base font-semibold">
                  {t("settings.advanced.zeroToken.title", {
                    defaultValue: "0/0 Token 异常",
                  })}
                </h3>
                <p className="text-sm text-muted-foreground font-normal">
                  {t("settings.advanced.zeroToken.description", {
                    defaultValue:
                      "单独配置空回保护与连续异常阈值，避免和故障转移核心参数混在一起。",
                  })}
                </p>
              </div>
            </div>
          </AccordionTrigger>
          <AccordionContent className="border-t border-border/50 px-6 pb-6 pt-4">
            <div className="space-y-6">
              {!isRunning && (
                <ProxyRunningNotice message={proxyRequiredMessage} />
              )}
              <ProxyAppTabs>
                {(appType) => (
                  <ZeroTokenConfigPanel
                    appType={appType}
                    disabled={!isRunning}
                  />
                )}
              </ProxyAppTabs>
            </div>
          </AccordionContent>
        </AccordionItem>

        <AccordionItem
          value="modelTest"
          className="rounded-xl glass-card overflow-hidden"
        >
          <AccordionTrigger className="px-6 py-4 hover:no-underline hover:bg-muted/50 data-[state=open]:bg-muted/50">
            <div className="flex items-center gap-3">
              <FlaskConical className="h-5 w-5 text-emerald-500" />
              <div className="text-left">
                <h3 className="text-base font-semibold">
                  {t("settings.advanced.modelTest.title")}
                </h3>
                <p className="text-sm text-muted-foreground font-normal">
                  {t("settings.advanced.modelTest.description")}
                </p>
              </div>
            </div>
          </AccordionTrigger>
          <AccordionContent className="border-t border-border/50 px-6 pb-6 pt-4">
            <ModelTestConfigPanel />
          </AccordionContent>
        </AccordionItem>

        <AccordionItem
          value="rectifier"
          className="rounded-xl glass-card overflow-hidden"
        >
          <AccordionTrigger className="px-6 py-4 hover:no-underline hover:bg-muted/50 data-[state=open]:bg-muted/50">
            <div className="flex items-center gap-3">
              <Zap className="h-5 w-5 text-purple-500" />
              <div className="text-left">
                <h3 className="text-base font-semibold">
                  {t("settings.advanced.rectifier.title")}
                </h3>
                <p className="text-sm text-muted-foreground font-normal">
                  {t("settings.advanced.rectifier.description")}
                </p>
              </div>
            </div>
          </AccordionTrigger>
          <AccordionContent className="border-t border-border/50 px-6 pb-6 pt-4">
            <RectifierConfigPanel />
          </AccordionContent>
        </AccordionItem>

        <AccordionItem
          value="globalProxy"
          className="rounded-xl glass-card overflow-hidden"
        >
          <AccordionTrigger className="px-6 py-4 hover:no-underline hover:bg-muted/50 data-[state=open]:bg-muted/50">
            <div className="flex items-center gap-3">
              <Globe className="h-5 w-5 text-cyan-500" />
              <div className="text-left">
                <h3 className="text-base font-semibold">
                  {t("settings.advanced.globalProxy.title")}
                </h3>
                <p className="text-sm text-muted-foreground font-normal">
                  {t("settings.advanced.globalProxy.description")}
                </p>
              </div>
            </div>
          </AccordionTrigger>
          <AccordionContent className="border-t border-border/50 px-6 pb-6 pt-4">
            <GlobalProxySettings />
          </AccordionContent>
        </AccordionItem>
      </Accordion>

      <ConfirmDialog
        isOpen={showProxyConfirm}
        variant="info"
        title={t("confirm.proxy.title")}
        message={t("confirm.proxy.message")}
        confirmText={t("confirm.proxy.confirm")}
        onConfirm={() => void handleProxyConfirm()}
        onCancel={() => setShowProxyConfirm(false)}
      />
    </motion.div>
  );
}
