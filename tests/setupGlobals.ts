// Polyfill ResizeObserver for jsdom/happy-dom
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof globalThis.ResizeObserver;
}

if (typeof globalThis.window !== "undefined") {
  Object.defineProperty(globalThis.window, "scrollTo", {
    value: () => {},
    writable: true,
    configurable: true,
  });
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
