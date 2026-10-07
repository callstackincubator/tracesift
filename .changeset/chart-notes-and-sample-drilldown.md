---
"tracesift": patch
---

Split the notes under every chart into a reading key, the controls, and a folded list of caveats.

Each chart on the drill-down had grown one italic paragraph that did three jobs at once — how to drive the chart, how to read it, and what it does not measure — so a reader who wanted any one of them read past the other two. The longest ran 187 words. The key is now a line of its own, the controls sit beside it, and the caveats are bullets behind **What this doesn't show**, each leading with its claim: *rows are not stack depth*, *spacing is not time*, *height is not effect time*. Notes are capped at a readable measure rather than taking the width of the chart above them.

The render tree's note quoted the checked-in fixture's depth — "nests 110 deep and reads at 26" — at readers looking at their own recording. Both figures are now measured from the open commit.

Fix the drill-down and the AI readings on the two bundled samples.

A React sample card now offers **Explore**, as a CPU sample's task card already did. Nothing on that card could open before: it was the one React report with no commit timeline behind it, so the drill-down was switched off for it rather than left to open on an error.

A sample report was handed to the browser without being registered anywhere, so every link out of one asked the server for an analysis it had never heard of: **Open in Explore** answered "that task is not part of this analysis", and an AI reading or a copied prompt answered that the analysis had expired. Sample ids now resolve wherever an uploaded or saved one does, against a copy, so a reading written onto a sample card cannot leak into the next reader's. The React sample gained the commit timeline its drill-down fetches, built by `react-explore.ts` from the same recording its cards came from.
