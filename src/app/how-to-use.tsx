"use client";

import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { Button, Heading, ScrollArea, Tabs } from "@rozenite/ui";

function GuideStep({
  number,
  title,
  children,
}: {
  number: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <li className="guide-step">
      <span className="guide-step-number">{number}</span>
      <div><strong>{title}</strong><p>{children}</p></div>
    </li>
  );
}

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

    previousFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
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
          <div>
            <span className="guide-kicker">Quick start</span>
            <Heading level={2} id={titleId}>Analyze your first profile</Heading>
            <p>From capture to actionable performance insights in a few steps.</p>
          </div>
          <Button
            ref={closeButtonRef}
            type="button"
            size="sm"
            variant="ghost"
            className="guide-close"
            aria-label="Close guide"
            onClick={onClose}
          >
            ×
          </Button>
        </div>

        <Tabs className="how-to-tabs" defaultValue="cpu">
          <Tabs.List size="sm" aria-label="Profile guides">
            <Tabs.Tab value="cpu"><span className="guide-tab-icon">JS</span> CPU profile</Tabs.Tab>
            <Tabs.Tab value="react"><span className="guide-tab-icon react">⚛</span> React profile</Tabs.Tab>
          </Tabs.List>

          <Tabs.Panel className="how-to-panel" value="cpu">
            <ScrollArea className="how-to-scroll">
              <ol className="how-to-steps">
                <GuideStep number={1} title="Capture JavaScript execution">
                  Use Chrome Performance, the React Native DevTools CPU profiler, or Hermes Profiler.
                </GuideStep>
                <GuideStep number={2} title="Add the exported profile">
                  Drop a <code>.json</code> file into the upload area.
                </GuideStep>
                <GuideStep number={3} title="Run the analysis">
                  Select <strong>Analyze profile</strong>. The slowest execution paths appear first.
                </GuideStep>
                <GuideStep number={4} title="Turn an insight into a fix">
                  Use <strong>Copy handoff</strong> to copy a focused diagnostic for your AI assistant.
                </GuideStep>
              </ol>
            </ScrollArea>
          </Tabs.Panel>

          <Tabs.Panel className="how-to-panel" value="react">
            <ScrollArea className="how-to-scroll">
              <ol className="how-to-steps">
                <GuideStep number={1} title="Record component renders">
                  Open React DevTools Profiler, record the interaction, and export the profiling <code>.json</code>.
                </GuideStep>
                <GuideStep number={2} title="Choose your commit budget">
                  Keep the 16 ms default for 60 Hz, or use 8.33 ms for a 120 Hz target.
                </GuideStep>
                <GuideStep number={3} title="Upload and analyze">
                  Add the export and select <strong>Analyze profile</strong> to inspect over-budget commits.
                </GuideStep>
                <GuideStep number={4} title="Review actionable evidence">
                  Focus on the selected component issues, then generate a prompt for the issue you want to fix.
                </GuideStep>
              </ol>
            </ScrollArea>
          </Tabs.Panel>
        </Tabs>

        <div className="guide-privacy"><span>✓</span><p><strong>Private by design</strong>Your profile stays on this device. Raw uploads are never retained.</p></div>
      </div>
    </div>,
    portalRoot,
  );
}
