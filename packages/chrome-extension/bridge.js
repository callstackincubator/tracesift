const REQUEST_SOURCE = "tracesift-web-v1";
const RESPONSE_SOURCE = "tracesift-extension-v1";

window.addEventListener("message", (event) => {
  if (event.source !== window || event.origin !== window.location.origin) return;
  const message = event.data;
  if (!message || message.source !== REQUEST_SOURCE || typeof message.requestId !== "string") return;

  chrome.runtime.sendMessage(message).then(
    (response) => window.postMessage({ source: RESPONSE_SOURCE, requestId: message.requestId, ...response }, event.origin),
    (error) => window.postMessage({ source: RESPONSE_SOURCE, requestId: message.requestId, ok: false, error: error?.message || "TraceSift extension did not respond." }, event.origin),
  );
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "PAIRED_BY_USER") {
    window.postMessage({ source: RESPONSE_SOURCE, type: "PAIRED_BY_USER" }, window.location.origin);
  }
});

window.postMessage({ source: RESPONSE_SOURCE, type: "READY" }, window.location.origin);
