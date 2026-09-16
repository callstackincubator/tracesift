"use client";

import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { Button, Heading, ScrollArea, Tabs, Text } from "@rozenite/ui";

export function HowToUseGuide({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const titleId = useId();
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;

    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = requestAnimationFrame(() => closeButtonRef.current?.focus());

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);

    return () => {
      cancelAnimationFrame(frame);
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
      previousFocusRef.current?.focus();
    };
  }, [open, onClose]);

  if (!open || typeof document === "undefined") return null;

  const portalRoot =
    document.querySelector("[data-slot='plugin-shell']") ?? document.body;

  return createPortal(
    <div className="how-to-overlay">
      <div className="how-to-backdrop" onClick={onClose} />
      <div
        className="how-to-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="how-to-drawer-header">
          <Heading level={2} id={titleId}>
            How to use it?
          </Heading>
          <Button
            ref={closeButtonRef}
            type="button"
            size="sm"
            variant="outline"
            onClick={onClose}
          >
            Close
          </Button>
        </div>

        <div className="how-to-intro">
          <Text render={<p />}>
            Choose a profile type, upload a capture from the React Native app, then analyze locally.
          </Text>
          <Text render={<p />} tone="neutral">
            Profiles stay on this device. Configure the model with{" "}
            <code>perf-ai model</code> and restart the server.
          </Text>
        </div>

        <Tabs className="how-to-tabs" defaultValue="cpu">
          <Tabs.List size="sm" aria-label="Profile guides">
            <Tabs.Tab value="cpu">CPU profile</Tabs.Tab>
            <Tabs.Tab value="react">React profile</Tabs.Tab>
          </Tabs.List>

          <Tabs.Panel className="how-to-panel" value="cpu">
            <ScrollArea className="how-to-scroll">
              <ol className="how-to-steps">
                <li>Record JS execution (Chrome Performance / React Native DevTools CPU profiler / Hermes Profiler).</li>
                <li>
                  Upload a CPU or hermes profile.
                </li>
                <li>
                  Drop the file, click <strong>Analyze profile</strong>.
                </li>
                <li>
                  Review bottlenecks (slowest first). Use <strong>Generate Prompt</strong> /{" "}
                  <strong>Copy Prompt</strong> to debug a hotspot.
                </li>
              </ol>
            </ScrollArea>
          </Tabs.Panel>

          <Tabs.Panel className="how-to-panel" value="react">
            <ScrollArea className="how-to-scroll">
              <ol className="how-to-steps">
                <li>
                  Record with React DevTools Profiler and export the profiling <code>.json</code> (export format 5).
                </li>
                <li>
                  Set <strong>Commit budget (ms)</strong> (default 16; e.g. 8.33 for a higher refresh-rate target).
                </li>
                <li>Drop the file and analyze.</li>
                <li>
                  The UI shows selected over-budget component issues, not a raw ranking. Empty findings can mean every
                  commit stayed within budget.
                </li>
                <li>
                  Use <strong>Generate Prompt</strong> on an issue the same way as CPU results.
                </li>
              </ol>
            </ScrollArea>
          </Tabs.Panel>
        </Tabs>
      </div>
    </div>,
    portalRoot,
  );
}
