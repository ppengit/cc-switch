import React, { useRef, useEffect } from "react";
import { EditorView, basicSetup } from "codemirror";
import { markdown } from "@codemirror/lang-markdown";
import { oneDark } from "@codemirror/theme-one-dark";
import { EditorState } from "@codemirror/state";
import { placeholder as placeholderExt } from "@codemirror/view";

interface MarkdownEditorProps {
  value: string;
  onChange?: (value: string) => void;
  placeholder?: string;
  darkMode?: boolean;
  readOnly?: boolean;
  className?: string;
  minHeight?: string;
  maxHeight?: string;
}

const MarkdownEditor: React.FC<MarkdownEditorProps> = ({
  value,
  onChange,
  placeholder: placeholderText = "",
  darkMode = false,
  readOnly = false,
  className = "",
  minHeight = "300px",
  maxHeight,
}) => {
  const editorRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);

  useEffect(() => {
    if (!editorRef.current) return;

    // 定义基础主题
    const baseTheme = EditorView.baseTheme({
      "&": {
        height: "100%",
        minHeight,
        maxHeight: maxHeight || "none",
      },
      ".cm-scroller": {
        overflow: "auto",
        fontFamily:
          "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
        fontSize: "14px",
      },
      "&light .cm-content, &dark .cm-content": {
        padding: "12px 0",
      },
      "&light .cm-editor, &dark .cm-editor": {
        backgroundColor: "transparent",
      },
      "&.cm-focused": {
        outline: "none",
      },
    });

    const extensions = [
      basicSetup,
      markdown(),
      baseTheme,
      EditorView.lineWrapping,
      EditorState.readOnly.of(readOnly),
    ];

    if (!readOnly) {
      extensions.push(
        placeholderExt(placeholderText),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && onChange) {
            onChange(update.state.doc.toString());
          }
        }),
      );
    } else {
      // 只读模式下隐藏光标和高亮行
      extensions.push(
        EditorView.theme({
          ".cm-cursor, .cm-dropCursor": { border: "none" },
          ".cm-activeLine": { backgroundColor: "transparent !important" },
          ".cm-activeLineGutter": { backgroundColor: "transparent !important" },
        }),
      );
    }

    // 如果启用深色模式，添加深色主题
    if (darkMode) {
      extensions.push(oneDark);
    } else {
      // 浅色模式下的简单样式调整，使其更融入 UI
      extensions.push(
        EditorView.theme(
          {
            "&": {
              backgroundColor: "transparent",
            },
            ".cm-content": {
              color: "hsl(var(--foreground))",
            },
            ".cm-gutters": {
              backgroundColor: "hsl(var(--muted))",
              color: "hsl(var(--muted-foreground))",
              borderRight: "1px solid hsl(var(--border))",
            },
            ".cm-activeLineGutter": {
              backgroundColor: "hsl(var(--muted))",
            },
          },
          { dark: false },
        ),
      );
    }

    // 创建初始状态
    const state = EditorState.create({
      doc: value,
      extensions,
    });

    // 创建编辑器视图
    const view = new EditorView({
      state,
      parent: editorRef.current,
    });

    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [darkMode, readOnly, minHeight, maxHeight, placeholderText]); // 添加 placeholderText 依赖以支持国际化切换

  // 当 value 从外部改变时更新编辑器内容
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

  return (
    <div
      ref={editorRef}
      className={`border border-border rounded-md overflow-hidden ${className}`}
    />
  );
};

export default MarkdownEditor;
