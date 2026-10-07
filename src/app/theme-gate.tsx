"use client";

import { useEffect, useSyncExternalStore, type ReactNode } from "react";

const ROZENITE_THEME_KEY = "@rozenite/ui:theme";

/** Nothing to subscribe to: "are we on the client" changes once, at mount. */
const noSubscribe = () => () => {};
const onClient = () => true;
const onServer = () => false;

/**
 * Hold the first paint until the stored theme is known.
 *
 * The shell reads the theme from `localStorage`, which the server cannot see,
 * so rendering it straight away hydrates light-on-server against dark-on-client
 * and React throws the whole tree away. Every page built on the shell needs
 * this, not just the first one.
 *
 * The gate deliberately does not open on an animation frame: browsers do not
 * run those in a background tab, and a page opened with `window.open` starts in
 * one — it would stay blank until the reader happened to focus it.
 */
export function ThemeGate({ children }: { children: ReactNode }) {
  const mounted = useSyncExternalStore(noSubscribe, onClient, onServer);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(ROZENITE_THEME_KEY);
      if (stored !== "light" && stored !== "dark") {
        localStorage.setItem(ROZENITE_THEME_KEY, "dark");
      }
    } catch {
      // Theme still applies for this session even if storage is unavailable.
    }
  }, []);

  if (!mounted) {
    return <div className="dark h-screen bg-background" />;
  }

  return <>{children}</>;
}
