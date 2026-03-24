import React from "react";
import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const cmMocks = vi.hoisted(() => {
  const viewInstances: Array<{
    state: {
      docText: string;
      doc: {
        toString: () => string;
        readonly length: number;
      };
      extensions: unknown[];
      update: (spec: {
        changes: { from: number; to: number; insert: string };
      }) => {
        changes: { from: number; to: number; insert: string };
      };
    };
    destroy: ReturnType<typeof vi.fn>;
    dispatch: ReturnType<typeof vi.fn>;
  }> = [];
  const updateListeners: Array<
    (update: {
      docChanged: boolean;
      state: {
        docText: string;
        doc: {
          toString: () => string;
          readonly length: number;
        };
      };
    }) => void
  > = [];

  const createState = (doc: string, extensions: unknown[]) => {
    const state = {
      docText: doc,
      doc: {
        toString: () => state.docText,
        get length() {
          return state.docText.length;
        },
      },
      extensions,
      update: (spec: {
        changes: { from: number; to: number; insert: string };
      }) => spec,
    };

    return state;
  };

  const reset = () => {
    viewInstances.length = 0;
    updateListeners.length = 0;
  };

  return {
    createState,
    reset,
    updateListeners,
    viewInstances,
  };
});

vi.mock("codemirror", () => {
  class MockEditorView {
    state: ReturnType<typeof cmMocks.createState>;
    destroy: ReturnType<typeof vi.fn>;
    dispatch: ReturnType<typeof vi.fn>;

    constructor({
      state,
      parent,
    }: {
      state: ReturnType<typeof cmMocks.createState>;
      parent: HTMLDivElement;
    }) {
      this.state = state;
      this.destroy = vi.fn();
      this.dispatch = vi.fn((transaction) => {
        if (transaction?.changes) {
          this.state.docText = transaction.changes.insert;
        }
      });

      parent.appendChild(document.createElement("div"));
      cmMocks.viewInstances.push(this);
    }
  }

  return {
    basicSetup: { type: "basicSetup" },
    EditorView: Object.assign(MockEditorView, {
      baseTheme: vi.fn((theme) => ({ type: "baseTheme", theme })),
      theme: vi.fn((theme) => ({ type: "theme", theme })),
      editable: {
        of: vi.fn((editable) => ({ type: "editable", editable })),
      },
      updateListener: {
        of: vi.fn((listener) => {
          cmMocks.updateListeners.push(listener);
          return { type: "updateListener", listener };
        }),
      },
    }),
  };
});

vi.mock("@codemirror/theme-one-dark", () => ({
  oneDark: { type: "oneDark" },
}));

vi.mock("@codemirror/state", () => ({
  EditorState: {
    create: ({ doc, extensions }: { doc: string; extensions: unknown[] }) =>
      cmMocks.createState(doc, extensions),
    readOnly: {
      of: vi.fn((readOnly) => ({ type: "readOnly", readOnly })),
    },
  },
}));

vi.mock("@codemirror/view", () => ({
  placeholder: vi.fn((text) => ({ type: "placeholder", text })),
  Decoration: {
    none: { type: "none" },
    mark: vi.fn(({ class: className }) => ({
      range: (from: number, to: number) => ({
        type: "decoration",
        className,
        from,
        to,
      }),
    })),
    set: vi.fn((decorations) => ({ type: "decorationSet", decorations })),
  },
  ViewPlugin: {
    fromClass: vi.fn((pluginClass, spec) => ({ pluginClass, spec })),
  },
}));

import TextCodeEditor from "@/components/TextCodeEditor";

function InlineOnChangeHost() {
  const [value, setValue] = React.useState("KEY=value");

  return <TextCodeEditor value={value} onChange={(next) => setValue(next)} />;
}

describe("TextCodeEditor", () => {
  beforeEach(() => {
    cmMocks.reset();
  });

  it("should not recreate the editor when parent rerenders with a new inline onChange", () => {
    const { unmount } = render(<InlineOnChangeHost />);

    expect(cmMocks.viewInstances).toHaveLength(1);
    expect(cmMocks.updateListeners).toHaveLength(1);

    const editorView = cmMocks.viewInstances[0];

    act(() => {
      editorView.state.docText = "KEY=updated";
      cmMocks.updateListeners[0]({
        docChanged: true,
        state: editorView.state,
      });
    });

    expect(cmMocks.viewInstances).toHaveLength(1);
    expect(cmMocks.updateListeners).toHaveLength(1);
    expect(editorView.destroy).not.toHaveBeenCalled();

    unmount();

    expect(editorView.destroy).toHaveBeenCalledTimes(1);
  });
});
