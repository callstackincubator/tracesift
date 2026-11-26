"use client";

import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, PluginHeader, PluginShell } from "@rozenite/ui";

import { ThemeGate } from "@/app/theme-gate";
import type { CaptureRecord, CaptureTarget } from "@/lib/capture-types";

type ExtensionReply = { ok: boolean; error?: string; targets?: CaptureTarget[] };

const REQUEST_SOURCE = "tracesift-web-v1";
const RESPONSE_SOURCE = "tracesift-extension-v1";

function message(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function stateLabel(state: CaptureRecord["state"]): string {
  return state.replaceAll("_", " ");
}

function CapturePage() {
  const [extensionState, setExtensionState] = useState<"disconnected" | "connecting" | "connected">("disconnected");
  const [targets, setTargets] = useState<CaptureTarget[]>([]);
  const [selectedTab, setSelectedTab] = useState<number | null>(null);
  const [captures, setCaptures] = useState<CaptureRecord[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requests = useRef(new Map<string, { resolve: (reply: ExtensionReply) => void; timeout: number }>());

  const bridgeRequest = useCallback((type: string, payload: Record<string, unknown> = {}): Promise<ExtensionReply> => {
    const requestId = crypto.randomUUID();
    return new Promise((resolve) => {
      const timeout = window.setTimeout(() => {
        requests.current.delete(requestId);
        resolve({ ok: false, error: "The TraceSift extension did not respond. Install or reload it, then try again." });
      }, 5000);
      requests.current.set(requestId, { resolve, timeout });
      window.postMessage({ source: REQUEST_SOURCE, requestId, type, ...payload }, window.location.origin);
    });
  }, []);

  const loadCaptures = useCallback(async () => {
    const response = await fetch("/api/captures", { cache: "no-store" });
    const body = await response.json() as { captures?: CaptureRecord[] };
    if (response.ok) setCaptures(body.captures ?? []);
  }, []);

  const refreshTargets = useCallback(async () => {
    const reply = await bridgeRequest("LIST_TARGETS");
    if (!reply.ok) throw new Error(reply.error || "Could not read Chrome tabs.");
    const nextTargets = reply.targets ?? [];
    setTargets(nextTargets);
    setSelectedTab((current) => nextTargets.some((target) => target.tabId === current) ? current : nextTargets[0]?.tabId ?? null);
  }, [bridgeRequest]);

  useEffect(() => {
    const pendingRequests = requests.current;
    const receive = (event: MessageEvent) => {
      if (event.source !== window || event.origin !== window.location.origin || event.data?.source !== RESPONSE_SOURCE) return;
      if (event.data.type === "PAIRED_BY_USER") {
        setExtensionState("connected");
        setError(null);
        void refreshTargets().catch((caught) => setError(message(caught)));
        return;
      }
      const pending = requests.current.get(event.data.requestId);
      if (!pending) return;
      window.clearTimeout(pending.timeout);
      requests.current.delete(event.data.requestId);
      pending.resolve(event.data as ExtensionReply);
    };
    window.addEventListener("message", receive);
    const initialLoad = window.setTimeout(() => void loadCaptures(), 0);
    const connectionCheck = window.setTimeout(() => void bridgeRequest("STATUS").then((reply) => {
      if (reply.ok) {
        setExtensionState("connected");
        void refreshTargets().catch(() => undefined);
      }
    }), 0);
    const timer = window.setInterval(() => void loadCaptures(), 1000);
    return () => {
      window.removeEventListener("message", receive);
      window.clearTimeout(initialLoad);
      window.clearTimeout(connectionCheck);
      window.clearInterval(timer);
      for (const pending of pendingRequests.values()) window.clearTimeout(pending.timeout);
      pendingRequests.clear();
    };
  }, [bridgeRequest, loadCaptures, refreshTargets]);

  const connect = async () => {
    setBusy(true); setError(null); setExtensionState("connecting");
    try {
      const reply = await bridgeRequest("STATUS");
      if (!reply.ok) throw new Error("Click the TraceSift Capture extension in Chrome’s toolbar while this exact page is active, then check again.");
      setExtensionState("connected");
      await refreshTargets();
    } catch (caught) {
      setExtensionState("disconnected");
      setError(message(caught));
    } finally { setBusy(false); }
  };

  const start = async () => {
    const target = targets.find((candidate) => candidate.tabId === selectedTab);
    if (!target) return;
    setBusy(true); setError(null);
    let created: { capture: CaptureRecord; uploadToken: string } | undefined;
    try {
      const response = await fetch("/api/captures", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target }),
      });
      const body = await response.json() as { capture?: CaptureRecord; uploadToken?: string; error?: string };
      if (!response.ok || !body.capture || !body.uploadToken) throw new Error(body.error || "Could not create the capture.");
      created = { capture: body.capture, uploadToken: body.uploadToken };
      const reply = await bridgeRequest("START", {
        baseUrl: window.location.origin,
        captureId: body.capture.id,
        token: body.uploadToken,
        target,
      });
      if (!reply.ok) throw new Error(reply.error || "Chrome refused the profiling connection.");
      await loadCaptures();
    } catch (caught) {
      const text = message(caught);
      if (created) {
        await fetch(`/api/captures/${created.capture.id}/ingest/status`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${created.uploadToken}` },
          body: JSON.stringify({ state: "failed", stopReason: "error", error: text }),
        }).catch(() => undefined);
      }
      setError(text);
    } finally { setBusy(false); }
  };

  const stop = async (id: string) => {
    setError(null);
    const response = await fetch(`/api/captures/${id}/stop`, { method: "POST" });
    const body = await response.json().catch(() => ({})) as { error?: string };
    if (!response.ok) setError(body.error || "Could not stop the capture.");
    await loadCaptures();
  };

  const remove = async (id: string) => {
    setError(null);
    const response = await fetch(`/api/captures/${id}`, { method: "DELETE" });
    const body = await response.json().catch(() => ({})) as { error?: string };
    if (!response.ok) setError(body.error || "Could not delete the capture.");
    await loadCaptures();
  };

  const active = useMemo(() => captures.find((capture) => ["pending", "attaching", "recording", "stop_requested", "flushing", "enriching"].includes(capture.state)), [captures]);

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
            <span className="eyebrow">Chrome performance capture</span>
            <h1>Record demanding flows without loading the trace into DevTools.</h1>
            <p>Chrome collects the same timeline and V8 CPU samples. TraceSift streams the result to local disk and keeps it until you delete it.</p>
          </section>

          {error && <div className="capture-error" role="alert"><strong>Capture could not continue</strong><span>{error}</span></div>}

          <section className="capture-panel">
            <div className="capture-panel-head">
              <div><span className="capture-step">1</span><div><h2>Connect Chrome</h2><p>The extension is a local CDP bridge and attaches only when you start recording.</p></div></div>
              <span className={`capture-connection ${extensionState}`}>{extensionState}</span>
            </div>
            {extensionState !== "connected" ? (
              <div className="capture-connect">
                <p className="capture-approval"><strong>Approve this page in Chrome</strong><span>Click the TraceSift Capture extension in Chrome’s toolbar while this page is active. A website cannot approve itself.</span></p>
                <Button type="button" onClick={() => void connect()} disabled={busy}>{busy ? "Checking…" : "Check connection"}</Button>
                <p>For development, load <code>packages/chrome-extension</code> from <code>chrome://extensions</code>. Chrome 125+ is required.</p>
              </div>
            ) : (
              <div className="capture-target-row">
                <label htmlFor="capture-target">Website tab</label>
                <select id="capture-target" value={selectedTab ?? ""} onChange={(event) => setSelectedTab(Number(event.target.value))} disabled={Boolean(active)}>
                  {targets.length === 0 && <option value="">No available website tabs</option>}
                  {targets.map((target) => <option key={target.tabId} value={target.tabId}>{target.title} — {target.url}</option>)}
                </select>
                <Button type="button" size="sm" variant="ghost" onClick={() => void refreshTargets().catch((caught) => setError(message(caught)))} disabled={Boolean(active)}>Refresh tabs</Button>
              </div>
            )}
          </section>

          <section className="capture-panel">
            <div className="capture-panel-head">
              <div><span className="capture-step">2</span><div><h2>Record the flow</h2><p>TraceSift automatically stops before Chrome’s trace buffer fills.</p></div></div>
            </div>
            {active ? (
              <div className="capture-active">
                <div className="capture-pulse" aria-hidden="true" />
                <div className="capture-active-copy">
                  <strong>{active.target.title}</strong>
                  <span>{stateLabel(active.state)} · {Math.round(active.bufferUsage * 100)}% buffer · {active.eventCount.toLocaleString()} events received</span>
                  <div className="capture-buffer"><span style={{ width: `${Math.min(100, active.bufferUsage * 100)}%` }} /></div>
                </div>
                <Button type="button" onClick={() => void stop(active.id)} disabled={["stop_requested", "flushing", "enriching"].includes(active.state)}>
                  {["stop_requested", "flushing", "enriching"].includes(active.state) ? "Finishing…" : "Stop and save"}
                </Button>
              </div>
            ) : (
              <div className="capture-ready">
                <div><strong>Ready to record</strong><span>Start here, perform the flow in the selected tab, then return to stop.</span></div>
                <Button type="button" onClick={() => void start()} disabled={busy || extensionState !== "connected" || selectedTab === null}>{busy ? "Starting…" : "Start capture"}</Button>
              </div>
            )}
          </section>

          <section className="capture-library">
            <div className="capture-library-head"><div><span className="eyebrow">Local library</span><h2>Saved captures</h2></div><span>{captures.length} capture{captures.length === 1 ? "" : "s"}</span></div>
            {captures.length === 0 ? <div className="capture-empty">Completed captures will remain here until you delete them.</div> : (
              <div className="capture-list">
                {captures.map((capture) => (
                  <article className="capture-item" key={capture.id}>
                    <div className="capture-item-main">
                      <div className="capture-item-title"><strong>{capture.title}</strong><span className={`capture-state ${capture.state}`}>{stateLabel(capture.state)}</span></div>
                      <span>{new Date(capture.createdAt).toLocaleString()} · {capture.eventCount.toLocaleString()} events · {capture.export ? formatBytes(capture.export.sizeBytes) : formatBytes(capture.byteCount)}</span>
                      <small title={capture.target.url}>{capture.target.url}</small>
                      {capture.error && <p className="capture-item-error">{capture.error}</p>}
                      {capture.warnings.length > 0 && <p className="capture-item-warning">{capture.warnings.join(" ")}</p>}
                    </div>
                    <div className="capture-item-actions">
                      {capture.export && <Button render={<a href={`/api/captures/${capture.id}/download`} download />} size="sm">Export trace</Button>}
                      {!["pending", "attaching", "recording", "stop_requested", "flushing", "enriching"].includes(capture.state) && <Button type="button" size="sm" variant="ghost" onClick={() => void remove(capture.id)}>Delete</Button>}
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
