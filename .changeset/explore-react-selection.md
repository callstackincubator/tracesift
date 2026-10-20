---
"@callstack/tracesift-explore": minor
---

Extend selection to the React explorer. `ExploreView` now forwards `selection` to `ReactExplorer` as well as `TaskExplorer`, and `ReactExplorer` takes it directly: a reader can pick components out of a commit's render tree and its component table, both views ring and number them, and a click adds or removes one instead of zooming the icicle.

A pick is a `reactNodeKey` — `<rootId>.<commitIndex>.<fiberId>` — rather than a bare fiber id, because a fiber id is unique inside its root and nowhere else. Naming the commit is what lets a selection outlive the commit picker: a reader working a cascade steps through commits, and a per-commit set would empty itself under exactly that navigation. The commit chart stays navigation, as the task focus does.

Unlike the task side, one pick rings one fiber. A task tree merges a function's call sites, so one pick has to ring every box drawn of it; React merges nothing, and two renders of a component are two fibers with their own causes, changed props and time. The render tree says so when a pick of the open commit is not drawn — collapsed as a pass-through, or below one that was.

New exports: `reactNodeKey`, `reactNodeKeyParts`, `pickedReactFlame` and `reactPicksInCommit`. `ReactComponentTable` and `ReactRenderTree` each take an optional `selection`. Hosts that pass nothing see the views exactly as before.
