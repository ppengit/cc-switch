// Polyfill ResizeObserver for jsdom/happy-dom
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof globalThis.ResizeObserver;
}

const createMockDomRect = () => ({
  x: 0,
  y: 0,
  top: 0,
  left: 0,
  bottom: 0,
  right: 0,
  width: 0,
  height: 0,
  toJSON: () => ({}),
});

if (typeof globalThis.Range !== "undefined") {
  const rangePrototype = globalThis.Range.prototype as Range & {
    getBoundingClientRect?: () => DOMRect;
    getClientRects?: () => DOMRectList;
  };

  if (typeof rangePrototype.getBoundingClientRect !== "function") {
    Object.defineProperty(rangePrototype, "getBoundingClientRect", {
      value: () => createMockDomRect(),
      writable: true,
      configurable: true,
    });
  }

  if (typeof rangePrototype.getClientRects !== "function") {
    Object.defineProperty(rangePrototype, "getClientRects", {
      value: () => {
        const rect = createMockDomRect();
        const rectList = [rect] as unknown as DOMRectList & DOMRect[];
        rectList.item = (index: number) => rectList[index] ?? null;
        return rectList;
      },
      writable: true,
      configurable: true,
    });
  }
}

if (typeof globalThis.window !== "undefined") {
  Object.defineProperty(globalThis.window, "scrollTo", {
    value: () => {},
    writable: true,
    configurable: true,
  });

  if (typeof globalThis.window.matchMedia !== "function") {
    Object.defineProperty(globalThis.window, "matchMedia", {
      value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }),
      writable: true,
      configurable: true,
    });
  }
}

if (typeof globalThis.Element !== "undefined") {
  const elementPrototype = globalThis.Element.prototype;

  if (typeof elementPrototype.hasPointerCapture !== "function") {
    Object.defineProperty(elementPrototype, "hasPointerCapture", {
      value: () => false,
      writable: true,
      configurable: true,
    });
  }

  if (typeof elementPrototype.setPointerCapture !== "function") {
    Object.defineProperty(elementPrototype, "setPointerCapture", {
      value: () => {},
      writable: true,
      configurable: true,
    });
  }

  if (typeof elementPrototype.releasePointerCapture !== "function") {
    Object.defineProperty(elementPrototype, "releasePointerCapture", {
      value: () => {},
      writable: true,
      configurable: true,
    });
  }

  if (typeof elementPrototype.scrollIntoView !== "function") {
    Object.defineProperty(elementPrototype, "scrollIntoView", {
      value: () => {},
      writable: true,
      configurable: true,
    });
  }
}

const storage = new Map<string, string>();

if (
  typeof globalThis.localStorage === "undefined" ||
  typeof globalThis.localStorage?.getItem !== "function"
) {
  Object.defineProperty(globalThis, "localStorage", {
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, String(value));
      },
      removeItem: (key: string) => {
        storage.delete(key);
      },
      clear: () => {
        storage.clear();
      },
      key: (index: number) => Array.from(storage.keys())[index] ?? null,
      get length() {
        return storage.size;
      },
    },
    configurable: true,
  });
}
