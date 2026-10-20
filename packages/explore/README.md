# @callstack/tracesift-explore

The drill-down views TraceSift opens from a result card: a task's timeline, flame
graph, call tree and culprit table, a React recording's commit strip with its
render tree and component table, and the legacy node-descent card view.

The same components render in two places — the Next app's `/explore` route and
the plugin's single-file panel — so a reader sees one Explore whichever opened
it.

## Install

```sh
npm install @callstack/tracesift-explore @rozenite/ui react react-dom
```

`react`, `react-dom` (>=19) and `@rozenite/ui` (>=2.4.0) are peer dependencies:
the views are components, and they should be the same components the rest of your
tree renders.

```tsx
import { ExploreView } from "@callstack/tracesift-explore";
import "@callstack/tracesift-explore/styles.css";

<ExploreView
  task={{ state: "ready", handoff }}
  focusNodeId={focus}
  onFocusChange={(id) => history.replaceState(null, "", `?task=0&focus=${id}`)}
  onClose={() => window.close()}
/>;
```

`@callstack/tracesift-explore/styles.css` is a compiled stylesheet — Tailwind v4
preflight, the `@rozenite/ui` design tokens, and the Explore rules. Your bundler
needs no Tailwind, no PostCSS plugin and no `content` list. Load it once.

## What comes in, what goes out

The views are given their data and report what the reader clicked. Nothing here
fetches, reads `window.location` or `localStorage`, or calls `window.close`: a
browser tab and an iframe panel have different answers to all three, and neither
belongs in a component.

| Prop | Who owns it |
| --- | --- |
| `task`, `react`, `card` | The host. Fetch, parse, then hand the value over. |
| `focusNodeId`, `onFocusChange` | The host, when it has an address bar to keep in step. Both optional: without them the view holds its own focus. |
| `commitKey`, `defaultCommitKey`, `onCommitChange` | Same, for a recording's selected commit. Keys are `<rootId>.<commitIndex>`. |
| `onClose` | The host. Given, a `Close` button is rendered; the action is the host's. |
| `selection` | The host, for a task or a React explorer. Given, the views ring and number the picked frames and a click adds or removes one instead of navigating; `onToggleSelection` reports the click. Omitted, the views behave as they always did. A task frame is a `TaskTreeNode.id`; a React component is a `reactNodeKey`, `<rootId>.<commitIndex>.<fiberId>`, so a pick survives the commit picker. |

Theme likewise belongs to the host: `PluginShell` applies its own `.dark` class
and the sheet styles both. The Next app gates its first paint on the stored
theme before mounting the views; a panel inherits whatever its host decided.

## Exports

- `ExploreView` — the page body: load states, the three drill-downs, the empty
  case, the footer.
- `TaskExplorer`, `ReactExplorer`, `CardExplorer` — the drill-downs on their own,
  for a host that arranges its own page around them.
- `FlameGraph` — the library's graph with two additions: `minLabelWidth`, which
  lets Explore scale the label threshold by its own zoom, and `selectedLabels`
  plus `selectOnly`, which let a host ring several frames at once and take a click
  as a pick rather than a zoom. Vendored because patching a peer dependency is not
  something a consumer can be asked to do; see the header of
  `src/flame-graph/flame-graph.tsx`.
- `FrameSelection`, and the helpers a host needs to draw its own picking:
  `pickNumber`, `pickedClass`, `picking`, `isPickableName`, `PickTick`, and
  `pickedFlamePicks` for a host drawing its own flame graph, which is what decides
  that one pick of a function rings every box drawn of it. On the React side,
  `reactNodeKey` and `reactNodeKeyParts` build and read the id a picked component
  is held by, `pickedReactFlame` maps picks onto a commit's icicle, and
  `reactPicksInCommit` counts the picks one commit accounts for. React picks one
  fiber at a time: its tree merges nothing, so two renders of a component are two
  renders.
- The model the views read: `TaskCard`, `TaskTreeNode`, `TaskCardSet`,
  `TaskTimeline`, `TimelineBox`, `ReactExplore`, `ReactExploreCommit`,
  `ReactExploreNode`, `ReactCard`, `ReactComponentClass`, `FrameClass`,
  `ProfileCard`, plus `focusedTree`, `focusedReactTree`, `isShownFrame`,
  `isOwnComponent`, `formatMs`, `formatReactMs`, `shortLocationLabel` and the
  builders that produce the hand-offs (`selectTaskCards`, `extractTasks`,
  `buildReactCards`, `buildReactExplore`, `parseReactExport`).
- The hand-off shapes: `TaskHandoff`, `ReactExploreHandoff`, `CardHandoff`.

## Building this package

```sh
npm run build          # dist/*.js, dist/*.d.ts and dist/explore.css
npm run typecheck
```

`src/styles/tailwind.css` is the entry `dist/explore.css` is compiled from; the
`@source` lines there decide which utilities survive, including the ones a host
passes as plain strings (`overflow-visible` on the flame graph). Change a class
name in a component without leaving it in this package's sources and it disappears
from the sheet.

The rules in `src/styles/shared.css` and `src/styles/explore.css` are lifted from
the app's `src/app/globals.css`, which keeps its own copy because its results page
uses the same primitives. Both sheets define the same names with the same rules,
so loading one, the other, or both draws the same thing — but a fix to either has
to be made in both.
