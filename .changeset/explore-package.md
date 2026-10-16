---
"@callstack/tracesift-explore": minor
---

Add `@callstack/tracesift-explore`: the Explore drill-down — a task's timeline, flame graph, call tree and culprit table, a React recording's commit strip, render tree and component table, and the legacy card view — as components that take their hand-off, their focus and their commit selection by props.

The Next `/explore` route and the plugin's bundled panel now render the same views from the same package. Ships a precompiled stylesheet (`@callstack/tracesift-explore/styles.css`) so a consumer needs neither Tailwind nor `patch-package`: the flame graph's `minLabelWidth`, previously a local patch to `@rozenite/ui`, is now part of the graph this package exports.
