# TraceSift Capture extension

This Manifest V3 extension is the privileged CDP bridge used by the local
TraceSift capture page. Chrome 125 or newer is required.

For local development:

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select this directory.
4. Open TraceSift's exact `/capture` page and click **TraceSift Capture** in
   Chrome's toolbar while that tab is active. Then choose **Check connection**.

The toolbar click is the pairing approval. A loopback website cannot approve
itself, and reloading or navigating the approved tab clears the approval. The
extension attaches only after an explicit recording request from that tab.

Chrome buffers the recording internally. On stop, the extension pulls Chrome's
`ReturnAsStream` result in fixed-size chunks, waiting for each local disk append
before requesting the next one. It never uploads captures to an external
service. A browser or renderer crash before Chrome exposes the completed stream
can still make that recording unrecoverable.
