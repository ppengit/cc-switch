import { invoke } from "@tauri-apps/api/core";
import type { SessionMessage, SessionMeta } from "@/types";

export interface DeleteSessionOptions {
  providerId: string;
  sessionId: string;
  sourcePath: string;
}

export interface DeleteSessionResult extends DeleteSessionOptions {
  success: boolean;
  error?: string;
}

export const sessionsApi = {
  async list(): Promise<SessionMeta[]> {
    return await invoke("list_sessions");
  },

  async listRecent(options: {
    appType: string;
    limit?: number;
  }): Promise<SessionMeta[]> {
    const { appType, limit } = options;
    return await invoke("list_recent_sessions", { appType, limit });
  },

  async getMessages(
    providerId: string,
    sourcePath: string,
  ): Promise<SessionMessage[]> {
    return await invoke("get_session_messages", { providerId, sourcePath });
  },

  async delete(options: DeleteSessionOptions): Promise<boolean> {
    const { providerId, sessionId, sourcePath } = options;
    return await invoke("delete_session", {
      providerId,
      sessionId,
      sourcePath,
    });
  },

  async deleteMany(
    items: DeleteSessionOptions[],
  ): Promise<DeleteSessionResult[]> {
    return await invoke("delete_sessions", { items });
  },

  async setSessionTitleMapping(options: {
    appType: string;
    sessionId: string;
    sourcePath?: string | null;
    customTitle: string;
  }): Promise<boolean> {
    const { appType, sessionId, sourcePath, customTitle } = options;
    return await invoke("set_session_title_mapping", {
      appType,
      sessionId,
      sourcePath: sourcePath ?? null,
      customTitle,
    });
  },

  async clearSessionTitleMapping(options: {
    appType: string;
    sessionId: string;
    sourcePath?: string | null;
  }): Promise<boolean> {
    const { appType, sessionId, sourcePath } = options;
    return await invoke("clear_session_title_mapping", {
      appType,
      sessionId,
      sourcePath: sourcePath ?? null,
    });
  },

  async launchTerminal(options: {
    command: string;
    cwd?: string | null;
    customConfig?: string | null;
  }): Promise<boolean> {
    const { command, cwd, customConfig } = options;
    return await invoke("launch_session_terminal", {
      command,
      cwd,
      customConfig,
    });
  },
};
