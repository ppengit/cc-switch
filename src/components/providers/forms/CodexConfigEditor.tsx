import React, { useState } from "react";
import { CodexAuthSection, CodexConfigSection } from "./CodexConfigSections";
import { CodexCommonConfigModal } from "./CodexCommonConfigModal";

interface CodexConfigEditorProps {
  authValue: string;

  configValue: string;

  providerName?: string;

  showRemoteCompaction?: boolean;

  onAuthChange: (value: string) => void;

  onConfigChange: (value: string) => void;

  onAuthBlur?: () => void;

  useCommonConfig: boolean;

  onCommonConfigToggle: (checked: boolean) => void;

  commonConfigSnippet: string;

  onCommonConfigSnippetChange: (value: string) => boolean;

  onCommonConfigErrorClear: () => void;

  commonConfigError: string;

  authError: string;

  configError: string; // config.toml 错误提示

  onExtract?: () => void;

  isExtracting?: boolean;

  showCommonConfig?: boolean;
}

const CodexConfigEditor: React.FC<CodexConfigEditorProps> = ({
  authValue,
  configValue,
  providerName,
  showRemoteCompaction,
  onAuthChange,
  onConfigChange,
  onAuthBlur,
  useCommonConfig,
  onCommonConfigToggle,
  commonConfigSnippet,
  onCommonConfigSnippetChange,
  onCommonConfigErrorClear,
  commonConfigError,
  authError,
  configError,
  onExtract,
  isExtracting,
  showCommonConfig = true,
}) => {
  const [isCommonConfigModalOpen, setIsCommonConfigModalOpen] = useState(false);

  const handleCloseCommonConfigModal = () => {
    onCommonConfigErrorClear();
    setIsCommonConfigModalOpen(false);
  };

  return (
    <div className="space-y-6">
      {/* Auth JSON Section */}
      <CodexAuthSection
        value={authValue}
        onChange={onAuthChange}
        onBlur={onAuthBlur}
        error={authError}
      />

      {/* Config TOML Section */}
      <CodexConfigSection
        value={configValue}
        onChange={onConfigChange}
        providerName={providerName}
        showRemoteCompaction={showRemoteCompaction}
        useCommonConfig={useCommonConfig}
        onCommonConfigToggle={onCommonConfigToggle}
        onEditCommonConfig={() => setIsCommonConfigModalOpen(true)}
        commonConfigError={commonConfigError}
        configError={configError}
        showCommonConfig={showCommonConfig}
      />

      {/* Common Config Modal */}
      {showCommonConfig && (
        <CodexCommonConfigModal
          isOpen={isCommonConfigModalOpen}
          onClose={handleCloseCommonConfigModal}
          value={commonConfigSnippet}
          onSave={onCommonConfigSnippetChange}
          error={commonConfigError}
          onExtract={onExtract}
          isExtracting={isExtracting}
        />
      )}
    </div>
  );
};

export default CodexConfigEditor;
