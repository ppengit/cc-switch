import type { ReactNode } from "react";
import {
  QueryClientProvider,
  type QueryClient,
} from "@tanstack/react-query";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { queryClient as defaultQueryClient } from "@/lib/query";
import { UpdateProvider } from "./contexts/UpdateContext";

interface AppProvidersProps {
  children: ReactNode;
  client?: QueryClient;
}

export function AppProviders({
  children,
  client = defaultQueryClient,
}: AppProvidersProps) {
  return (
    <QueryClientProvider client={client}>
      <TooltipProvider delayDuration={200}>
        <ThemeProvider defaultTheme="system" storageKey="cc-switch-theme">
          <UpdateProvider>
            {children}
            <Toaster />
          </UpdateProvider>
        </ThemeProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}
