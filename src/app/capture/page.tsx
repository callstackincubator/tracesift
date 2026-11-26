"use client";

import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Button, PluginHeader, PluginShell } from "@rozenite/ui";

import { ThemeGate } from "@/app/theme-gate";
import type { CaptureRecord } from "@/lib/capture-types";

const ACTIVE = ["pending", "attaching", "recording", "stop_requested", "flushing", "enriching"];

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function CapturePage() {
  const [captures, setCaptures] = useState<CaptureRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const loadCaptures = useCallback(async () => {
    const response = await fetch("/api/captures", { cache: "no-store" });
    const body = await response.json() as { captures?: CaptureRecord[] };
    if (response.ok) setCaptures(body.captures ?? []);
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(() => void loadCaptures(), 0);
    const timer = window.setInterval(() => void loadCaptures(), 1000);
    return () => { window.clearTimeout(initial); window.clearInterval(timer); };
  }, [loadCaptures]);

  const act = async (id: string, method: "DELETE" | "POST") => {
    setError(null);
    const path = method === "POST" ? `/api/captures/${id}/stop` : `/api/captures/${id}`;
    const response = await fetch(path, { method });
    const body = await response.json().catch(() => ({})) as { error?: string };
    if (!response.ok) setError(body.error || "Could not update the capture.");
    await loadCaptures();
  };

  return (
    <PluginShell>
      <PluginHeader>
        <PluginHeader.Title className="brand" render={<Link href="/" />}>
          <Image src="/callstack-logo.png" alt="" width={30} height={30} priority />
          <span><span className="brand-name">TraceSift</span><small>by Callstack</small></span>
        </PluginHeader.Title>
        <PluginHeader.Actions>
          <Button render={<Link href="/" />} size="sm" variant="ghost">Analyze profile</Button>
          <PluginHeader.ThemeSwitcher />
        </PluginHeader.Actions>
      </PluginHeader>
      <PluginShell.Body>
        <main className="capture-workspace">
          <section className="capture-intro">
            <span className="eyebrow">React Native capture</span>
            <h1>Recorded profiles</h1>
            <p>Use <code>tracesift record start --platform rn</code> to record a running app. Captures streamed to TraceSift appear here.</p>
          </section>
          {error && <div className="capture-error" role="alert">{error}</div>}
          <section className="capture-library">
            <div className="capture-library-head"><div><span className="eyebrow">Local library</span><h2>Saved captures</h2></div><span>{captures.length} capture{captures.length === 1 ? "" : "s"}</span></div>
            {captures.length === 0 ? <div className="capture-empty">Completed captures will remain here until you delete them.</div> : (
              <div className="capture-list">
                {captures.map((capture) => (
                  <article className="capture-item" key={capture.id}>
                    <div className="capture-item-main">
                      <div className="capture-item-title"><strong>{capture.title}</strong><span className={`capture-state ${capture.state}`}>{capture.state.replaceAll("_", " ")}</span></div>
                      <span>{new Date(capture.createdAt).toLocaleString()} · {capture.eventCount.toLocaleString()} events · {formatBytes(capture.export?.sizeBytes ?? capture.byteCount)}</span>
                      <small title={capture.target.url}>{capture.target.deviceName || capture.target.url}</small>
                      {capture.error && <p className="capture-item-error">{capture.error}</p>}
                      {capture.warnings.length > 0 && <p className="capture-item-warning">{capture.warnings.join(" ")}</p>}
                    </div>
                    <div className="capture-item-actions">
                      {capture.export && <Button render={<a href={`/api/captures/${capture.id}/download`} download />} size="sm">Export trace</Button>}
                      {ACTIVE.includes(capture.state) && !["stop_requested", "flushing", "enriching"].includes(capture.state) && <Button type="button" size="sm" onClick={() => void act(capture.id, "POST")}>Stop</Button>}
                      {!ACTIVE.includes(capture.state) && <Button type="button" size="sm" variant="ghost" onClick={() => void act(capture.id, "DELETE")}>Delete</Button>}
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>
        </main>
      </PluginShell.Body>
    </PluginShell>
  );
}

export default function Capture() {
  return <ThemeGate><CapturePage /></ThemeGate>;
}
