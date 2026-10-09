---
"@callstack/tracesift": patch
---

Show what a feature called, one band down, on every task card.

A card's boundary frames are the outermost frame of your own on each branch, and
its culprits are ranked by self time. Between the two, a frame that delegates
all of its work had nowhere to appear: `useSearchTypeMenuSections` holds 629 ms
across the longest task of the local trace, carries 0.1 ms in its own body, and
appeared in no culprit list anywhere in the recording. The card named the React
component above it and stopped.

Each boundary frame now carries the frames it called, by inclusive time, chosen
by the same rule the boundary frames themselves are — the outermost named frame
on each branch. They are an antichain, so their figures do not overlap, and the
card prints what they do not account for rather than letting three bands
covering a fifth of a frame read as the whole answer. The rows appear under the
active slice and in the model hand-off.
