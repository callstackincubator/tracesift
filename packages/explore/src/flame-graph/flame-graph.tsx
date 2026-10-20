/**
 * Vendored from `@rozenite/ui` (v2.4.0, `src/flame-graph/`).
 *
 * Two reasons this file is a copy rather than an import:
 *
 * 1. `minLabelWidth`. Explore scales the label threshold by its own zoom, so a
 *    frame filling the window still carries its name at 64×. That prop exists in
 *    this checkout only, through `patches/@rozenite+ui+2.4.0.patch`, and a
 *    consumer of this package cannot be asked to run patch-package. Everything
 *    else still comes from the library, which stays a peer dependency.
 * 2. The layout helpers (`layoutFlameGraph`, `getHeatBucket`, the heat-bucket
 *    class tables) are internal to the library's bundle and are not part of its
 *    public exports, so a patched graph cannot be assembled from outside.
 * 3. `selectedLabels`. Explore lets a reader pick several frames at once and
 *    carry them into a question, which needs a set rather than the library's
 *    single `selectedKey`, and a way to say which pick each ringed box is. The
 *    ring itself is the library's own styling question, so this stays an addition
 *    rather than a change to anything it already does.
 *
 * TODO(upstream): land `minLabelWidth` in @rozenite/ui and delete this file plus
 * `flame-graph-utils.ts`, importing both from the library instead. Anything else
 * the library changes upstream has to be copied here by hand until then.
 */
import { useMemo, useState, type ComponentProps, type KeyboardEvent, type ReactNode } from 'react';
import { cn, EmptyState, Text } from '@rozenite/ui';
import {
  getHeatBucket,
  heatBucketClassName,
  heatBucketMutedClassName,
  layoutFlameGraph,
  matchesHighlight,
  type FlameGraphFrame,
  type FlameGraphHeatBucket,
  type FlameGraphNode,
} from './flame-graph-utils.ts';

export type { FlameGraphFrame, FlameGraphNode };

const DEFAULT_ROW_HEIGHT = 20;
const DEFAULT_MIN_FRAME_WIDTH = 0.08;
// Below this width there's no room for even a truncated label to be legible.
const MIN_LABEL_WIDTH_PERCENT = 3;

function defaultFormatValue(value: number): string {
  return String(value);
}

function hasRenderableData(data: FlameGraphNode | null): data is FlameGraphNode {
  if (!data) {
    return false;
  }

  return data.value > 0 || (data.children?.length ?? 0) > 0;
}

export type FlameGraphProps = Omit<ComponentProps<'div'>, 'onSelect'> & {
  data: FlameGraphNode | null;
  /** Key of the zoomed frame. Uncontrolled when omitted. */
  focusedKey?: string;
  onFocusedKeyChange?: (key: string | null, node: FlameGraphNode | null) => void;
  /** Key of the frame rendered as selected. */
  selectedKey?: string;
  /**
   * Frames selected beyond `selectedKey`, as `{ [frameKey]: label }`. A frame
   * named here is drawn with the same ring `selectedKey` draws, plus `label`.
   *
   * A map rather than a second list of keys because a box already has exactly one
   * way to say "selected", and a renderer holding two sources of truth about one
   * frame is a renderer waiting to disagree with itself. The label is what a list
   * of keys cannot carry and a reader needs: the same frame is the fourth row
   * here and the first row in the table beside it, so only the order the reader
   * chose in can number them.
   */
  selectedLabels?: Readonly<Record<string, string>>;
  /**
   * When true, clicking a frame reports it through `onSelect` and nothing else —
   * the graph does not zoom into it. A host using this is collecting frames
   * rather than navigating, and a view that re-rooted itself under every click
   * would keep pulling frames out from under the reader's cursor.
   */
  selectOnly?: boolean;
  onSelect?: (key: string, node: FlameGraphNode) => void;
  /** Row height in pixels. @default 20 */
  rowHeight?: number;
  /** Formats a value for labels and hover text. @default String */
  formatValue?: (value: number) => string;
  /** Case-insensitive substring matched against each frame's name and
   *  tooltip. Matching frames are outlined, the rest are washed out. */
  highlight?: string;
  /** Frames narrower than this percentage of the viewport are not rendered. @default 0.08 */
  minFrameWidth?: number;
  /** Frames narrower than this percentage of the viewport carry no label. @default 3 */
  minLabelWidth?: number;
  /** Rendered instead of the graph when `data` is null or has no value. */
  emptyState?: ReactNode;
};

/**
 * An interactive flame graph for hierarchical profiling data (call stacks,
 * module/bundle sizes, ...). Click a frame to zoom into its subtree, press
 * `Escape` to zoom back out. Purely CSS/percentage-based — no measurement or
 * canvas/SVG involved — so it stays responsive for free.
 */
function FlameGraphRoot({
  className,
  data,
  focusedKey: focusedKeyProp,
  onFocusedKeyChange,
  selectedKey,
  selectedLabels,
  selectOnly,
  onSelect,
  rowHeight = DEFAULT_ROW_HEIGHT,
  formatValue = defaultFormatValue,
  highlight,
  minFrameWidth = DEFAULT_MIN_FRAME_WIDTH,
  minLabelWidth = MIN_LABEL_WIDTH_PERCENT,
  emptyState,
  onKeyDown,
  ...props
}: FlameGraphProps) {
  const [uncontrolledFocusedKey, setUncontrolledFocusedKey] = useState<string | null>(null);
  const focusedKey = focusedKeyProp ?? uncontrolledFocusedKey ?? undefined;

  const { frames, depthCount } = useMemo(
    () => layoutFlameGraph(data, { focusedKey, minFrameWidth }),
    [data, focusedKey, minFrameWidth],
  );

  const rows = useMemo(() => {
    const grouped: FlameGraphFrame[][] = Array.from({ length: depthCount }, () => []);
    for (const frame of frames) {
      grouped[frame.depth]?.push(frame);
    }
    return grouped;
  }, [frames, depthCount]);

  const resetFocus = () => {
    setUncontrolledFocusedKey(null);
    onFocusedKeyChange?.(null, null);
  };

  const handleFrameClick = (frame: FlameGraphFrame) => {
    // A host that is collecting frames rather than navigating gets the click and
    // nothing else; every other host sees exactly the behaviour this file had
    // before, including the order the two callbacks fire in.
    if (selectOnly) {
      onSelect?.(frame.key, frame.node);
      return;
    }
    setUncontrolledFocusedKey(frame.key);
    onFocusedKeyChange?.(frame.key, frame.node);
    onSelect?.(frame.key, frame.node);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      resetFocus();
    }
    onKeyDown?.(event);
  };

  if (!hasRenderableData(data)) {
    return (
      <div data-slot="flame-graph" className={cn('flex flex-col', className)} {...props}>
        {emptyState ?? (
          <EmptyState
            title="No profiling data"
            description="Once frames are captured, the flame graph will appear here."
          />
        )}
      </div>
    );
  }

  return (
    <div
      data-slot="flame-graph"
      className={cn('overflow-auto', className)}
      onKeyDown={handleKeyDown}
      {...props}
    >
      <div
        style={{ height: depthCount * rowHeight }}
        className="relative w-full transition-[height] duration-150 ease-out motion-reduce:transition-none"
      >
        {rows.map((rowFrames, depth) => (
          <div key={depth} className="relative" style={{ height: rowHeight }}>
            {rowFrames.map((frame) => {
              // A plain lookup, guarded: a frame key is a caller's string and an
              // inherited `Object.prototype` name would otherwise read as picked.
              const selectedLabel = Object.prototype.hasOwnProperty.call(selectedLabels ?? {}, frame.key)
                ? selectedLabels?.[frame.key]
                : undefined;
              return (
                <FlameGraphFrameButton
                  key={frame.key}
                  frame={frame}
                  formatValue={formatValue}
                  highlight={highlight}
                  minLabelWidth={minLabelWidth}
                  selected={frame.key === selectedKey || selectedLabel !== undefined}
                  selectedLabel={selectedLabel}
                  onClick={handleFrameClick}
                />
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

type FlameGraphFrameButtonProps = {
  frame: FlameGraphFrame;
  formatValue: (value: number) => string;
  highlight: string | undefined;
  minLabelWidth: number;
  selected: boolean;
  /** Rendered before the name when a multi-select names which pick this is. */
  selectedLabel?: string;
  onClick: (frame: FlameGraphFrame) => void;
};

function FlameGraphFrameButton({
  frame,
  formatValue,
  highlight,
  minLabelWidth,
  selected,
  selectedLabel,
  onClick,
}: FlameGraphFrameButtonProps) {
  const { node, left, width, heat } = frame;
  const bucket = getHeatBucket(heat);
  const formattedValue = formatValue(node.value);
  const matched = matchesHighlight(node, highlight);

  return (
    <button
      type="button"
      data-slot="flame-graph-frame"
      // A native tooltip, not the `Tooltip` component — a profile can have
      // thousands of frames, and mounting a base-ui popup root per frame
      // would be far too heavy.
      title={`${node.tooltip ?? node.name} — ${formattedValue}`}
      aria-label={`${node.name}: ${formattedValue}`}
      onClick={() => onClick(frame)}
      style={{ left: `${left}%`, width: `${width}%` }}
      className={cn(
        'absolute inset-y-0 overflow-hidden border-r border-background/50 px-1 text-left',
        // Zooming only changes a surviving frame's position and width, so
        // transitioning them animates the whole graph with no extra
        // dependency and nothing to tear down.
        'transition-[left,width] duration-150 ease-out motion-reduce:transition-none',
        'outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
        matched ? heatBucketClassName[bucket] : heatBucketMutedClassName[bucket],
        // A match is outlined rather than merely left undimmed: a matching
        // frame with no self time sits in the palest bucket, so on its own
        // "not washed out" reads as less prominent than the frames around it.
        highlight && matched && 'ring-1 ring-primary ring-inset',
        selected && 'ring-2 ring-ring ring-inset',
      )}
    >
      {/* A pick is numbered in the order the reader chose them, which no label
          can carry on its own: the same frame reads as the fourth row here and
          the first row in the table beside it. Absolutely positioned so the
          number never eats the name it shares a box with. */}
      {selectedLabel !== undefined && (
        <span
          aria-hidden="true"
          className="absolute inset-y-[2px] left-[2px] z-[1] flex min-w-3.5 items-center justify-center rounded-full bg-primary px-1 text-[9px] leading-none font-medium text-primary-foreground"
        >
          {selectedLabel}
        </span>
      )}
      {width > minLabelWidth && (
        <span
          className={cn(
            'block truncate text-[11px] leading-none',
            highlight && matched && 'font-medium',
            selectedLabel !== undefined && 'pl-4',
          )}
        >
          {node.name}
        </span>
      )}
    </button>
  );
}

const LEGEND_ITEMS: { bucket: FlameGraphHeatBucket; label: string }[] = [
  { bucket: 'heaviest', label: 'Heaviest (>70%)' },
  { bucket: 'heavy', label: 'Heavy (40-70%)' },
  { bucket: 'moderate', label: 'Moderate (20-40%)' },
  { bucket: 'light', label: 'Light (<20%)' },
  { bucket: 'none', label: 'No self time' },
];

export type FlameGraphLegendProps = ComponentProps<'div'>;

/** Legend for the heat buckets `FlameGraph` colors frames by. */
function FlameGraphLegend({ className, ...props }: FlameGraphLegendProps) {
  return (
    <div
      data-slot="flame-graph-legend"
      className={cn('flex flex-wrap items-center gap-3', className)}
      {...props}
    >
      {LEGEND_ITEMS.map(({ bucket, label }) => (
        <div key={bucket} className="flex items-center gap-1.5">
          <span className={cn('h-3 w-3 shrink-0 rounded-sm', heatBucketClassName[bucket])} />
          <Text variant="caption">{label}</Text>
        </div>
      ))}
    </div>
  );
}

/** An interactive, zoomable flame graph for hierarchical profiling data. */
export const FlameGraph = Object.assign(FlameGraphRoot, {
  Legend: FlameGraphLegend,
});
