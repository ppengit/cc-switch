import { useState, useCallback, useEffect, useRef } from "react";
import {
  extractCodexBaseUrl,
  setCodexBaseUrl as setCodexBaseUrlInConfig,
  extractCodexModelName,
  setCodexModelName as setCodexModelNameInConfig,
  extractCodexReasoningEffort,
  setCodexReasoningEffort as setCodexReasoningEffortInConfig,
} from "@/utils/providerConfigUtils";
import { normalizeTomlText } from "@/utils/textNormalization";

interface UseCodexConfigStateProps {
  initialData?: {
    settingsConfig?: Record<string, unknown>;
  };
}

export function useCodexConfigState({ initialData }: UseCodexConfigStateProps) {
  const [codexAuth, setCodexAuthState] = useState("");
  const [codexConfig, setCodexConfigState] = useState("");
  const [codexApiKey, setCodexApiKey] = useState("");
  const [codexBaseUrl, setCodexBaseUrl] = useState("");
  const [codexModelName, setCodexModelName] = useState("");
  const [codexReasoningEffort, setCodexReasoningEffort] = useState("");
  const [codexAuthError, setCodexAuthError] = useState("");

  const isUpdatingCodexBaseUrlRef = useRef(false);
  const isUpdatingCodexModelNameRef = useRef(false);
  const isUpdatingCodexReasoningEffortRef = useRef(false);

  useEffect(() => {
    if (!initialData) return;

    const config = initialData.settingsConfig;
    if (typeof config === "object" && config !== null) {
      const auth = (config as any).auth || {};
      setCodexAuthState(JSON.stringify(auth, null, 2));

      const configStr =
        typeof (config as any).config === "string" ? (config as any).config : "";
      setCodexConfigState(configStr);

      const initialBaseUrl = extractCodexBaseUrl(configStr);
      if (initialBaseUrl) {
        setCodexBaseUrl(initialBaseUrl);
      }

      const initialModelName = extractCodexModelName(configStr);
      if (initialModelName) {
        setCodexModelName(initialModelName);
      }

      setCodexReasoningEffort(
        extractCodexReasoningEffort(configStr) || "xhigh",
      );

      try {
        if (auth && typeof auth.OPENAI_API_KEY === "string") {
          setCodexApiKey(auth.OPENAI_API_KEY);
        }
      } catch {
        // ignore
      }
    }
  }, [initialData]);

  useEffect(() => {
    if (isUpdatingCodexBaseUrlRef.current) {
      return;
    }
    const extracted = extractCodexBaseUrl(codexConfig) || "";
    if (extracted !== codexBaseUrl) {
      setCodexBaseUrl(extracted);
    }
  }, [codexConfig, codexBaseUrl]);

  useEffect(() => {
    if (isUpdatingCodexModelNameRef.current) {
      return;
    }
    const extracted = extractCodexModelName(codexConfig) || "";
    if (extracted !== codexModelName) {
      setCodexModelName(extracted);
    }
  }, [codexConfig, codexModelName]);

  useEffect(() => {
    if (isUpdatingCodexReasoningEffortRef.current) {
      return;
    }
    const extracted = extractCodexReasoningEffort(codexConfig) || "";
    if (extracted !== codexReasoningEffort) {
      setCodexReasoningEffort(extracted);
    }
  }, [codexConfig, codexReasoningEffort]);

  const getCodexAuthApiKey = useCallback((authString: string): string => {
    try {
      const auth = JSON.parse(authString || "{}");
      return typeof auth.OPENAI_API_KEY === "string" ? auth.OPENAI_API_KEY : "";
    } catch {
      return "";
    }
  }, []);

  useEffect(() => {
    const extractedKey = getCodexAuthApiKey(codexAuth);
    if (extractedKey !== codexApiKey) {
      setCodexApiKey(extractedKey);
    }
  }, [codexAuth, codexApiKey, getCodexAuthApiKey]);

  const validateCodexAuth = useCallback((value: string): string => {
    if (!value.trim()) return "";
    try {
      const parsed = JSON.parse(value);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return "Auth JSON must be an object";
      }
      return "";
    } catch {
      return "Invalid JSON format";
    }
  }, []);

  const setCodexAuth = useCallback(
    (value: string) => {
      setCodexAuthState(value);
      setCodexAuthError(validateCodexAuth(value));
    },
    [validateCodexAuth],
  );

  const setCodexConfig = useCallback(
    (value: string | ((prev: string) => string)) => {
      setCodexConfigState((prev) =>
        typeof value === "function"
          ? (value as (input: string) => string)(prev)
          : value,
      );
    },
    [],
  );

  const handleCodexApiKeyChange = useCallback(
    (key: string) => {
      const trimmed = key.trim();
      setCodexApiKey(trimmed);
      try {
        const auth = JSON.parse(codexAuth || "{}");
        auth.OPENAI_API_KEY = trimmed;
        setCodexAuth(JSON.stringify(auth, null, 2));
      } catch {
        // ignore
      }
    },
    [codexAuth, setCodexAuth],
  );

  const handleCodexBaseUrlChange = useCallback(
    (url: string) => {
      const sanitized = url.trim();
      setCodexBaseUrl(sanitized);

      if (!sanitized) {
        return;
      }

      isUpdatingCodexBaseUrlRef.current = true;
      setCodexConfig((prev) => setCodexBaseUrlInConfig(prev, sanitized));
      setTimeout(() => {
        isUpdatingCodexBaseUrlRef.current = false;
      }, 0);
    },
    [setCodexConfig],
  );

  const handleCodexModelNameChange = useCallback(
    (modelName: string) => {
      const trimmed = modelName.trim();
      setCodexModelName(trimmed);

      if (!trimmed) {
        return;
      }

      isUpdatingCodexModelNameRef.current = true;
      setCodexConfig((prev) => setCodexModelNameInConfig(prev, trimmed));
      setTimeout(() => {
        isUpdatingCodexModelNameRef.current = false;
      }, 0);
    },
    [setCodexConfig],
  );

  const handleCodexReasoningEffortChange = useCallback(
    (reasoningEffort: string) => {
      const trimmed = reasoningEffort.trim();
      setCodexReasoningEffort(trimmed);

      if (!trimmed) {
        return;
      }

      isUpdatingCodexReasoningEffortRef.current = true;
      setCodexConfig((prev) =>
        setCodexReasoningEffortInConfig(prev, trimmed),
      );
      setTimeout(() => {
        isUpdatingCodexReasoningEffortRef.current = false;
      }, 0);
    },
    [setCodexConfig],
  );

  const handleCodexConfigChange = useCallback(
    (value: string) => {
      const normalized = normalizeTomlText(value);
      setCodexConfig(normalized);

      if (!isUpdatingCodexBaseUrlRef.current) {
        const extracted = extractCodexBaseUrl(normalized) || "";
        if (extracted !== codexBaseUrl) {
          setCodexBaseUrl(extracted);
        }
      }

      if (!isUpdatingCodexModelNameRef.current) {
        const extractedModel = extractCodexModelName(normalized) || "";
        if (extractedModel !== codexModelName) {
          setCodexModelName(extractedModel);
        }
      }

      if (!isUpdatingCodexReasoningEffortRef.current) {
        const extractedReasoningEffort =
          extractCodexReasoningEffort(normalized) || "";
        if (extractedReasoningEffort !== codexReasoningEffort) {
          setCodexReasoningEffort(extractedReasoningEffort);
        }
      }
    },
    [
      setCodexConfig,
      codexBaseUrl,
      codexModelName,
      codexReasoningEffort,
    ],
  );

  const resetCodexConfig = useCallback(
    (auth: Record<string, unknown>, config: string) => {
      const authString = JSON.stringify(auth, null, 2);
      setCodexAuth(authString);
      setCodexConfig(config);

      const baseUrl = extractCodexBaseUrl(config);
      if (baseUrl) {
        setCodexBaseUrl(baseUrl);
      }

      const modelName = extractCodexModelName(config);
      if (modelName) {
        setCodexModelName(modelName);
      } else {
        setCodexModelName("");
      }

      setCodexReasoningEffort(extractCodexReasoningEffort(config) || "xhigh");

      try {
        if (auth && typeof auth.OPENAI_API_KEY === "string") {
          setCodexApiKey(auth.OPENAI_API_KEY);
        } else {
          setCodexApiKey("");
        }
      } catch {
        setCodexApiKey("");
      }
    },
    [setCodexAuth, setCodexConfig],
  );

  return {
    codexAuth,
    codexConfig,
    codexApiKey,
    codexBaseUrl,
    codexModelName,
    codexReasoningEffort,
    codexAuthError,
    setCodexAuth,
    setCodexConfig,
    handleCodexApiKeyChange,
    handleCodexBaseUrlChange,
    handleCodexModelNameChange,
    handleCodexReasoningEffortChange,
    handleCodexConfigChange,
    resetCodexConfig,
    getCodexAuthApiKey,
    validateCodexAuth,
  };
}
