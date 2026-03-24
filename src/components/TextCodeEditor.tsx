import React, { useEffect, useRef } from "react";
import { EditorView, basicSetup } from "codemirror";
import { oneDark } from "@codemirror/theme-one-dark";
import { EditorState } from "@codemirror/state";
import { useTranslation } from "react-i18next";
import { Wand2 } from "lucide-react";
import { toast } from "sonner";
import {
  Decoration,
  type DecorationSet,
  placeholder,
  type ViewUpdate,
  ViewPlugin,
} from "@codemirror/view";
import { formatTextConfig } from "@/utils/formatters";

export type TextCodeEditorLanguage = "plain" | "toml" | "env";
type DecorationRange = ReturnType<ReturnType<typeof Decoration.mark>["range"]>;

interface TextCodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  darkMode?: boolean;
  rows?: number;
  height?: string | number;
  readOnly?: boolean;
  language?: TextCodeEditorLanguage;
  showFormatButton?: boolean;
}

function addMatches(
  text: string,
  offset: number,
  regex: RegExp,
  className: string,
): DecorationRange[] {
  const matches: DecorationRange[] = [];

  for (const match of text.matchAll(regex)) {
    const value = match[0];
    const index = match.index ?? -1;
    if (index < 0 || value.length === 0) continue;
    matches.push(
      Decoration.mark({ class: className }).range(
        offset + index,
        offset + index + value.length,
      ),
    );
  }

  return matches;
}

function buildSyntaxDecorations(
  view: EditorView,
  language: TextCodeEditorLanguage,
): DecorationSet {
  if (language === "plain") {
    return Decoration.none;
  }

  const decorations: DecorationRange[] = [];

  for (const { from, to } of view.visibleRanges) {
    const text = view.state.doc.sliceString(from, to);
    const lineStartPattern = "(?<=^|\\n)";

    if (language === "toml") {
      decorations.push(
        ...addMatches(
          text,
          from,
          /(?<=^|\n)\s*\[\[?[^\]\n]+\]\]?/g,
          "cm-live-text-section",
        ),
      );
    }

    decorations.push(
      ...addMatches(text, from, /(?<=^|\n)\s*#.*$/gm, "cm-live-text-comment"),
    );

    const keyPattern =
      language === "env"
        ? new RegExp(
            `${lineStartPattern}\\s*[A-Za-z_][A-Za-z0-9_.-]*(?=\\s*=)`,
            "g",
          )
        : new RegExp(`${lineStartPattern}\\s*[A-Za-z0-9_.\"'-]+(?=\\s*=)`, "g");
    decorations.push(...addMatches(text, from, keyPattern, "cm-live-text-key"));
    decorations.push(
      ...addMatches(
        text,
        from,
        /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g,
        "cm-live-text-string",
      ),
    );
    decorations.push(
      ...addMatches(
        text,
        from,
        /\b(?:true|false|on|off|yes|no)\b/gi,
        "cm-live-text-boolean",
      ),
    );
    decorations.push(
      ...addMatches(
        text,
        from,
        /\b-?(?:0|[1-9]\d*)(?:\.\d+)?\b/g,
        "cm-live-text-number",
      ),
    );
  }

  return Decoration.set(decorations, true);
}

function createSyntaxHighlightExtension(language: TextCodeEditorLanguage) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = buildSyntaxDecorations(view, language);
      }

      update(update: ViewUpdate) {
        if (update.docChanged || update.viewportChanged) {
          this.decorations = buildSyntaxDecorations(update.view, language);
        }
      }
    },
    {
      decorations: (value) => value.decorations,
    },
  );
}

const TextCodeEditor: React.FC<TextCodeEditorProps> = ({
  value,
  onChange,
  placeholder: placeholderText = "",
  darkMode = false,
  rows = 12,
  height,
  readOnly = false,
  language = "plain",
  showFormatButton,
}) => {
  const { t } = useTranslation();
  const editorRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    if (!editorRef.current) return;

    const minHeightPx = height ? undefined : Math.max(1, rows) * 18;
    const heightValue =
      typeof height === "number" ? `${height}px` : height || undefined;

    const baseTheme = EditorView.baseTheme({
      ".cm-editor": {
        border: "1px solid hsl(var(--border))",
        borderRadius: "0.5rem",
        background: "transparent",
      },
      ".cm-editor.cm-focused": {
        outline: "none",
        borderColor: "hsl(var(--primary))",
      },
      ".cm-scroller": {
        background: "transparent",
      },
      ".cm-gutters": {
        background: "transparent",
        borderRight: "1px solid hsl(var(--border))",
        color: "hsl(var(--muted-foreground))",
      },
      ".cm-selectionBackground, .cm-content ::selection": {
        background: "hsl(var(--primary) / 0.18)",
      },
      ".cm-selectionMatch": {
        background: "hsl(var(--primary) / 0.12)",
      },
      ".cm-activeLine": {
        background: "hsl(var(--primary) / 0.08)",
      },
      ".cm-activeLineGutter": {
        background: "hsl(var(--primary) / 0.08)",
      },
      ".cm-live-text-comment": {
        color: "hsl(var(--muted-foreground))",
        fontStyle: "italic",
      },
      ".cm-live-text-key": {
        color: "hsl(var(--foreground))",
        fontWeight: "600",
      },
      ".cm-live-text-section": {
        color: "hsl(var(--primary))",
        fontWeight: "700",
      },
      ".cm-live-text-string": {
        color: "hsl(25 85% 45%)",
      },
      ".cm-live-text-number": {
        color: "hsl(220 70% 45%)",
      },
      ".cm-live-text-boolean": {
        color: "hsl(160 60% 35%)",
        fontWeight: "600",
      },
    });

    const sizingTheme = EditorView.theme({
      "&": heightValue
        ? { height: heightValue }
        : { minHeight: `${minHeightPx}px` },
      ".cm-scroller": { overflow: "auto" },
      ".cm-content": {
        fontFamily:
          "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
        fontSize: "14px",
      },
    });

    const extensions = [
      basicSetup,
      placeholder(placeholderText),
      EditorState.readOnly.of(readOnly),
      EditorView.editable.of(!readOnly),
      baseTheme,
      sizingTheme,
      createSyntaxHighlightExtension(language),
    ];

    if (!readOnly) {
      extensions.push(
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onChangeRef.current(update.state.doc.toString());
          }
        }),
      );
    }

    if (darkMode) {
      extensions.push(oneDark);
      extensions.push(
        EditorView.theme({
          ".cm-editor": {
            border: "1px solid hsl(var(--border))",
            borderRadius: "0.5rem",
            background: "transparent",
          },
          ".cm-editor.cm-focused": {
            outline: "none",
            borderColor: "hsl(var(--primary))",
          },
          ".cm-scroller": {
            background: "transparent",
          },
          ".cm-gutters": {
            background: "transparent",
            borderRight: "1px solid hsl(var(--border))",
            color: "hsl(var(--muted-foreground))",
          },
          ".cm-selectionBackground, .cm-content ::selection": {
            background: "hsl(var(--primary) / 0.18)",
          },
          ".cm-selectionMatch": {
            background: "hsl(var(--primary) / 0.12)",
          },
          ".cm-activeLine": {
            background: "hsl(var(--primary) / 0.08)",
          },
          ".cm-activeLineGutter": {
            background: "hsl(var(--primary) / 0.08)",
          },
          ".cm-live-text-comment": {
            color: "hsl(var(--muted-foreground))",
            fontStyle: "italic",
          },
          ".cm-live-text-key": {
            color: "hsl(210 40% 88%)",
            fontWeight: "600",
          },
          ".cm-live-text-section": {
            color: "hsl(197 100% 70%)",
            fontWeight: "700",
          },
          ".cm-live-text-string": {
            color: "hsl(32 100% 70%)",
          },
          ".cm-live-text-number": {
            color: "hsl(212 100% 75%)",
          },
          ".cm-live-text-boolean": {
            color: "hsl(161 65% 65%)",
            fontWeight: "600",
          },
        }),
      );
    }

    const state = EditorState.create({
      doc: value,
      extensions,
    });

    const view = new EditorView({
      state,
      parent: editorRef.current,
    });

    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [darkMode, height, language, placeholderText, readOnly, rows]);

  useEffect(() => {
    if (viewRef.current && viewRef.current.state.doc.toString() !== value) {
      const transaction = viewRef.current.state.update({
        changes: {
          from: 0,
          to: viewRef.current.state.doc.length,
          insert: value,
        },
      });
      viewRef.current.dispatch(transaction);
    }
  }, [value]);

  const handleFormat = () => {
    if (!viewRef.current) return;

    const currentValue = viewRef.current.state.doc.toString();
    const formatted = formatTextConfig(currentValue);
    onChangeRef.current(formatted);
    toast.success(t("common.tidyTextSuccess", { defaultValue: "整理完成" }), {
      closeButton: true,
    });
  };

  const isFullHeight = height === "100%";
  const shouldShowFormatButton = showFormatButton ?? !readOnly;

  return (
    <div
      style={{ width: "100%", height: isFullHeight ? "100%" : "auto" }}
      className={isFullHeight ? "flex flex-col" : ""}
    >
      <div
        ref={editorRef}
        style={{ width: "100%", height: isFullHeight ? undefined : "auto" }}
        className={isFullHeight ? "flex-1 min-h-0" : ""}
      />
      {shouldShowFormatButton && (
        <button
          type="button"
          onClick={handleFormat}
          className={`${isFullHeight ? "mt-2 flex-shrink-0" : "mt-2"} inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-700 transition-colors hover:text-blue-600 dark:text-gray-300 dark:hover:text-blue-400`}
        >
          <Wand2 className="h-3.5 w-3.5" />
          {t("common.tidyText", { defaultValue: "整理文本" })}
        </button>
      )}
    </div>
  );
};

export default TextCodeEditor;
