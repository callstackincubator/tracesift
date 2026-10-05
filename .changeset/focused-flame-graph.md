---
"@callstack/tracesift": patch
---

Give the flame graph the same cut as the call tree, and open it collapsed.

On a React profile the recorded stack spends its first dozen rows on `processRootScheduleInMicrotask`, `performWorkOnRoot`, `beginWork` and `commitPassiveMountOnFiber` — boxes that carry the full width of the task and name nothing a reader can change. A flame graph is read by eye rather than row by row, so those rows are not a scroll past, they are the part of the picture the eye lands on first.

The Flame graph tab now carries the `Everything` / `Your code only` toggle the call tree already had, drawing the same frames the Timeline draws, and defaults to the collapsed view. Dropping a frame lifts its children into its place and charges the time it burned in its own body to the nearest kept frame above it, so the figures agree with the timeline and the focused call tree. `Everything` is one click away for the times the reconciler is the thing being read.

The graph also zooms now, on the same `1×`–`64×` ladder the Timeline already uses. Clicking a frame has always re-laid the graph out across its subtree, and that stays — it is the right move when the question is "what is under this frame" — but it answers nothing when the question is "what are those forty slivers", because every one of them is still a sliver of whatever width the box happens to be. Zooming stretches the whole graph instead and scrolls it sideways, so a thin frame widens where it sits, beside the frames it ran beside. ⌘/Ctrl with the scroll wheel does the same about the pointer, and the view keeps whatever was under the middle of it (or under the pointer) in place rather than sliding it off to the left.

Two details that decide whether it is usable: the library's floor on frame width is divided by the zoom, without which zooming in would keep hiding exactly the frames it exists to reveal, and the drill-down now has a visible way out — a `zoomed into <frame>` line with a button, where Escape was the only exit before.

Zooming carries a patch to `@rozenite/ui`, which the flame graph comes from. Its two floors — the width under which a frame is not drawn, and the width under which it is drawn without its name — are shares of its own canvas, and stretching that canvas is exactly what zooming does here: at 64× a box filling the window outright is 1.6% of the canvas, so it rendered blank with its name reachable only by hovering it. The patch adds a `minLabelWidth` prop beside the `minFrameWidth` that was already there, and this view divides both by the zoom. The real home for it is upstream.

The wheel zooms continuously. A mouse notch multiplies the zoom by about 1.3 and a trackpad's smaller deltas move it proportionally, so the graph answers every event instead of sitting still until some threshold is cleared and then jumping a whole power of two. The `1×`–`64×` buttons stay as places to jump to, with a readout beside them for where a gesture actually landed.

Two things keep it at the browser's frame rate rather than React's. A gesture resizes the canvas through the DOM, which every frame follows for free because all of them are positioned in percentages of it — no render, no relayout of a thousand boxes per event — and the state that does need a render, the two width floors, is committed once the hand stops. And a burst of wheel events inside one frame is coalesced into a single resize, which is the common case on a trackpad: five events now cost 0.1 ms of arithmetic and one layout instead of five.

The Timeline zooms the same way, from the same code. It had the `1×`–`64×` buttons already and nothing else: no wheel, no pointer to zoom about, and a jump straight from 2× to 4× when what was wanted sat between them. Both charts place everything they draw as a share of one element — the timeline's boxes against the task's duration, the flame graph's frames against the subtree's time — so stretching that element is the whole of zooming on either, and the gesture, the pointer anchoring, the per-frame coalescing and the deferred commit are now one hook over both. The ruler re-spaces when the commit lands, the way the flame graph's floors do: on the 3.23 s task, 500 ms gradations at 1× and 100 ms at 3.7×.

