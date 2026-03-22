import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderForm } from "@/components/providers/forms/ProviderForm";

let capturedBasicFormFieldsProps: any;
let capturedClaudeFormFieldsProps: any;

const mockHandleClaudeBaseUrlChange = vi.fn();

vi.mock("@/lib/api", () => ({
  configApi: {
    getProviderDefaultTemplate: vi.fn().mockResolvedValue(""),
  },
}));

vi.mock("@/lib/api/providers", () => ({
  providersApi: {},
}));

vi.mock("@/utils/modelDiscoveryUtils", () => ({
  fetchCatalogModelIds: vi.fn(),
  supportsEndpointModelDiscovery: vi.fn().mockReturnValue(false),
}));

vi.mock("@/components/providers/forms/ProviderPresetSelector", () => ({
  ProviderPresetSelector: () => null,
}));

vi.mock("@/components/providers/forms/BasicFormFields", () => ({
  BasicFormFields: (props: any) => {
    capturedBasicFormFieldsProps = props;
    return <div data-testid="basic-form-fields" />;
  },
}));

vi.mock("@/components/providers/forms/ClaudeFormFields", () => ({
  ClaudeFormFields: (props: any) => {
    capturedClaudeFormFieldsProps = props;
    return <div data-testid="claude-form-fields" />;
  },
}));

vi.mock("@/components/providers/forms/CodexFormFields", () => ({
  CodexFormFields: () => null,
}));

vi.mock("@/components/providers/forms/GeminiFormFields", () => ({
  GeminiFormFields: () => null,
}));

vi.mock("@/components/providers/forms/OpenCodeFormFields", () => ({
  OpenCodeFormFields: () => null,
}));

vi.mock("@/components/providers/forms/OpenClawFormFields", () => ({
  OpenClawFormFields: () => null,
}));

vi.mock("@/components/providers/forms/OmoFormFields", () => ({
  OmoFormFields: () => null,
}));

vi.mock("@/components/providers/forms/CodexConfigEditor", () => ({
  default: () => null,
}));

vi.mock("@/components/providers/forms/CommonConfigEditor", () => ({
  CommonConfigEditor: () => null,
}));

vi.mock("@/components/providers/forms/GeminiConfigEditor", () => ({
  default: () => null,
}));

vi.mock("@/components/providers/forms/ProviderAdvancedConfig", () => ({
  ProviderAdvancedConfig: () => null,
}));

vi.mock("@/components/JsonEditor", () => ({
  default: () => null,
}));

vi.mock("@/components/providers/forms/hooks", () => ({
  useProviderCategory: () => ({ category: "third_party" }),
  useApiKeyState: () => ({
    apiKey: "",
    handleApiKeyChange: vi.fn(),
    showApiKey: vi.fn().mockReturnValue(true),
  }),
  useBaseUrlState: () => ({
    baseUrl: "",
    setBaseUrl: vi.fn(),
    codexBaseUrl: "",
    setCodexBaseUrl: vi.fn(),
    geminiBaseUrl: "",
    setGeminiBaseUrl: vi.fn(),
    handleClaudeBaseUrlChange: mockHandleClaudeBaseUrlChange,
    handleCodexBaseUrlChange: vi.fn(),
    handleGeminiBaseUrlChange: vi.fn(),
  }),
  useModelState: () => ({
    claudeModel: "",
    reasoningModel: "",
    defaultHaikuModel: "",
    defaultSonnetModel: "",
    defaultOpusModel: "",
    handleModelChange: vi.fn(),
  }),
  useCodexConfigState: () => ({
    codexAuth: "{}",
    codexConfig: "",
    codexApiKey: "",
    codexBaseUrl: "",
    codexModelName: "",
    codexReasoningEffort: "xhigh",
    codexAuthError: "",
    setCodexAuth: vi.fn(),
    handleCodexApiKeyChange: vi.fn(),
    handleCodexBaseUrlChange: vi.fn(),
    handleCodexModelNameChange: vi.fn(),
    handleCodexReasoningEffortChange: vi.fn(),
    handleCodexConfigChange: vi.fn(),
    resetCodexConfig: vi.fn(),
  }),
  useApiKeyLink: () => ({
    shouldShowApiKeyLink: false,
    websiteUrl: "",
    isPartner: false,
    partnerPromotionKey: undefined,
  }),
  useTemplateValues: () => ({
    templateValues: {},
    templateValueEntries: [],
    selectedPreset: null,
    handleTemplateValueChange: vi.fn(),
    validateTemplateValues: vi.fn().mockReturnValue(true),
  }),
  useCommonConfigSnippet: () => ({
    useCommonConfig: false,
    commonConfigSnippet: "",
    commonConfigError: "",
    handleCommonConfigToggle: vi.fn(),
    handleCommonConfigSnippetChange: vi.fn(),
    isExtracting: false,
    handleExtract: vi.fn(),
  }),
  useCodexCommonConfig: () => ({
    useCommonConfig: false,
    commonConfigSnippet: "",
    commonConfigError: "",
    handleCommonConfigToggle: vi.fn(),
    handleCommonConfigSnippetChange: vi.fn(),
    isExtracting: false,
    handleExtract: vi.fn(),
    clearCommonConfigError: vi.fn(),
  }),
  useSpeedTestEndpoints: () => [],
  useCodexTomlValidation: () => ({
    configError: "",
    debouncedValidate: vi.fn(),
  }),
  useGeminiConfigState: () => ({
    geminiEnv: "",
    geminiConfig: "",
    geminiApiKey: "",
    geminiBaseUrl: "",
    geminiModel: "",
    envError: "",
    configError: "",
    handleGeminiApiKeyChange: vi.fn(),
    handleGeminiBaseUrlChange: vi.fn(),
    handleGeminiModelChange: vi.fn(),
    handleGeminiEnvChange: vi.fn(),
    handleGeminiConfigChange: vi.fn(),
    resetGeminiConfig: vi.fn(),
    envStringToObj: vi.fn().mockReturnValue({}),
    envObjToString: vi.fn().mockReturnValue(""),
  }),
  useGeminiCommonConfig: () => ({
    useCommonConfig: false,
    commonConfigSnippet: "",
    commonConfigError: "",
    handleCommonConfigToggle: vi.fn(),
    handleCommonConfigSnippetChange: vi.fn(),
    isExtracting: false,
    handleExtract: vi.fn(),
    clearCommonConfigError: vi.fn(),
  }),
  useOmoModelSource: () => ({
    omoModelOptions: [],
    omoModelVariantsMap: {},
    omoPresetMetaMap: {},
    existingOpencodeKeys: [],
  }),
  useOpencodeFormState: () => ({
    opencodeProviderKey: "",
    setOpencodeProviderKey: vi.fn(),
    opencodeNpm: "",
    opencodeApiKey: "",
    opencodeBaseUrl: "",
    opencodeModels: {},
    opencodeExtraOptions: {},
    handleOpencodeNpmChange: vi.fn(),
    handleOpencodeApiKeyChange: vi.fn(),
    handleOpencodeBaseUrlChange: vi.fn(),
    handleOpencodeModelsChange: vi.fn(),
    handleOpencodeExtraOptionsChange: vi.fn(),
    resetOpencodeState: vi.fn(),
  }),
  useOmoDraftState: () => ({
    omoAgents: [],
    setOmoAgents: vi.fn(),
    omoCategories: [],
    setOmoCategories: vi.fn(),
    omoOtherFieldsStr: "",
    setOmoOtherFieldsStr: vi.fn(),
    resetOmoDraftState: vi.fn(),
  }),
  useOpenclawFormState: () => ({
    openclawProviderKey: "",
    setOpenclawProviderKey: vi.fn(),
    openclawBaseUrl: "",
    openclawApiKey: "",
    openclawApi: "openai-completions",
    openclawModels: [],
    openclawUserAgent: true,
    existingOpenclawKeys: [],
    handleOpenclawBaseUrlChange: vi.fn(),
    handleOpenclawApiKeyChange: vi.fn(),
    handleOpenclawApiChange: vi.fn(),
    handleOpenclawModelsChange: vi.fn(),
    handleOpenclawUserAgentChange: vi.fn(),
    resetOpenclawState: vi.fn(),
  }),
}));

describe("ProviderForm seed sync scope", () => {
  beforeEach(() => {
    capturedBasicFormFieldsProps = undefined;
    capturedClaudeFormFieldsProps = undefined;
    mockHandleClaudeBaseUrlChange.mockReset();
  });

  it("新建供应商时启用字段联动包装", () => {
    render(
      <ProviderForm
        appId="claude"
        submitLabel="save"
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
        showButtons={false}
      />,
    );

    expect(capturedBasicFormFieldsProps.onNameChange).toEqual(
      expect.any(Function),
    );
    expect(capturedBasicFormFieldsProps.onWebsiteUrlChange).toEqual(
      expect.any(Function),
    );
    expect(capturedClaudeFormFieldsProps.onBaseUrlChange).not.toBe(
      mockHandleClaudeBaseUrlChange,
    );
  });

  it("编辑供应商时关闭字段联动包装", () => {
    render(
      <ProviderForm
        appId="claude"
        submitLabel="save"
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
        showButtons={false}
        initialData={{
          name: "Existing Provider",
          websiteUrl: "https://example.com",
          settingsConfig: { env: {} },
          category: "third_party",
        }}
      />,
    );

    expect(capturedBasicFormFieldsProps.onNameChange).toBeUndefined();
    expect(capturedBasicFormFieldsProps.onWebsiteUrlChange).toBeUndefined();
    expect(capturedClaudeFormFieldsProps.onBaseUrlChange).toBe(
      mockHandleClaudeBaseUrlChange,
    );
  });
});
