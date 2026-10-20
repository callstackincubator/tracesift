---
"@callstack/tracesift-explore": minor
---

Add frame selection to the task explorer. A host that passes `selection` to `TaskExplorer` or `ExploreView` lets its reader pick frames in the timeline, flame graph, call tree and culprit table: every view rings and numbers the picked frames, and a click adds or removes one instead of refocusing the timeline, call tree and culprits or zooming the flame graph.

Selection is separate from focus, so a set survives moving the view — pick frames on the timeline, open one in the call tree, and the others stay ringed. A picked frame inside a collapsed subtree opens its own row to show itself. The synthetic `(root)` row is not a frame and is not offered as one.

One pick rings the frame rather than one row of one view. The timeline draws a box per call and the merged tree one node per call site, so the ring follows the function into every box the flame graph draws of it, and clicking any of those is the second click on the pick that exists rather than a new one.

The package exports `FrameSelection`, `isPickableName`, `pickNumber`, `pickedClass`, `picking`, `PickTick` and `pickedFlamePicks` for a host drawing its own affordance. `FlameGraph` gains `selectedLabels` and `selectOnly`, which the library does not offer. `TaskFlameGraph` takes the whole task's tree as `taskTree` alongside the `focus` it draws, which is where a pick made in another view is resolved to the frames it rings. Hosts that pass nothing see the views exactly as before.
