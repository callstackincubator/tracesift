/**
 * TraceSift Explore — the drill-down views, as a library.
 *
 * The same components render in two places: the Next app's `/explore` route and
 * the plugin's single-HTML iframe panel. Neither host owns the drawing, so a
 * reader sees one Explore whatever opened it.
 *
 * Everything arrives by props. Nothing in here fetches, reads `window.location`,
 * touches storage, or calls `window.close`; a host that wants the address bar or
 * a panel's close button to follow the view is handed the callbacks to do it
 * with. `ExploreView` is the whole page body; `TaskExplorer`, `ReactExplorer`
 * and `CardExplorer` are its three drill-downs for a host that arranges its own
 * page around them.
 *
 * Styling comes from `@callstack/tracesift-explore/styles.css`: one already
 * compiled sheet — Tailwind v4, the `@rozenite/ui` tokens, and the Explore
 * rules — so a bundler needs no Tailwind setup of its own.
 */

export { ExploreView, type ExploreLoad, type ExploreViewProps, type ReactLoad, type TaskLoad } from "./components/explore-view.tsx";
export { CardExplorer } from "./components/card-explorer.tsx";
export { ReactExplorer, type ReactExplorerProps } from "./components/react-explorer.tsx";
export { TaskExplorer, type TaskExplorerProps } from "./components/task-explorer.tsx";
export { ChartNotes, STRETCH_ZOOM_NOTE, ZOOM_HINT } from "./components/chart-notes.tsx";
export { ZoomControls, formatZoom, useStretchZoom, ZOOM_STEPS, type StretchZoom } from "./components/stretch-zoom.tsx";
export { FlameLegend, TreeModeToggle, type TreeMode } from "./components/flame-legend.tsx";
export { TaskTimelineChart } from "./components/task-timeline-chart.tsx";
export { TaskCallTree, TaskCulpritTable } from "./components/task-views.tsx";
export { TaskFlameGraph, pickedFlamePicks } from "./components/task-flame-graph.tsx";
export {
  PickTick,
  isSelected,
  pickedClass,
  pickNumber,
  picking,
  isPickableName,
  type FrameSelection,
} from "./components/frame-selection.tsx";
export { CommitChart, ReactComponentTable, ReactRenderTree, commitKey, reactMs } from "./components/react-views.tsx";

/** The patched `FlameGraph`, exported so a host's graphs and these stay the same component. */
export { FlameGraph, type FlameGraphProps } from "./flame-graph/flame-graph.tsx";
export type { FlameGraphNode, FlameGraphFrame, FlameGraphHeatBucket } from "./flame-graph/flame-graph-utils.ts";

export type { CardHandoff, ReactExploreHandoff, TaskHandoff } from "./handoff.ts";

/* The model behind the views: the card shapes, the cuts the focused modes make,
   and the formatters the figures are written with. A host that builds its own
   entry points — a list of cards, a hand-off endpoint — needs these too. */
export {
  buildReactExplore,
  focusedReactTree,
  type ReactExplore,
  type ReactExploreCommit,
  type ReactExploreNode,
} from "./lib/react-explore.ts";
export {
  buildReactCards,
  classifyReactComponent,
  DEFAULT_FRAME_BUDGET_MS,
  isActionableCulprit,
  isOwnComponent,
  type ReactCard,
  type ReactCardCulprit,
  type ReactCardSet,
  type ReactComponentClass,
} from "./lib/react-cards.ts";
export {
  hookLabel,
  parseReactExport,
  splitSourceHint,
  unwrapComponentName,
  unwrapWrappers,
  type ReactCommit,
  type ReactFiber,
  type ReactRecording,
  type ReactRenderCause,
  type ReactRenderedFiber,
} from "./lib/react-commit-tree.ts";
export {
  CULPRIT_MIN_MS,
  focusedTree,
  pathlineFor,
  selectTaskCards,
  shapelineFor,
  type TaskCard,
  type TaskCardSet,
  type TaskCulprit,
  type TaskTreeNode,
} from "./lib/task-cards.ts";
export {
  attachMeasuredTasks,
  attachProfilerOverhead,
  extractTasks,
  type ProfileTask,
  type RawTaskInterval,
  type TaskBoundaryKind,
  type TaskSet,
} from "./lib/tasks.ts";
export {
  buildTaskTimeline,
  isNamedBuiltin,
  isShownFrame,
  SHOWN_CLASSES,
  type TaskTimeline,
  type TimelineBox,
} from "./lib/task-timeline.ts";
export {
  effectiveSelfMs,
  selectCards,
  type CardChildNode,
  type CardHighlight,
  type CardSelection,
  type ProfileCard,
  type RepeatedCaller,
  type RepeatedFunction,
} from "./lib/profile-cards.ts";
export { frameClassKey, ruleClassTable, type FrameClass, type FrameClassTable } from "./lib/frame-classes.ts";
export {
  frameLocations,
  namesItself,
  profileCardLocations,
  taskCardLocations,
  type FrameLocations,
} from "./lib/frame-location.ts";
export { compactLocation, frameSourceLocation, isReadableSourcePath, isSourceLabel, shortLocationLabel } from "./lib/source-location.ts";
export { formatMs, formatReactMs } from "./lib/format.ts";
export type { TaskInsight } from "./lib/task-insight-types.ts";
export type { CdpCallFrame, CdpProfile, CdpProfileNode } from "./lib/js-profiler-types.ts";
