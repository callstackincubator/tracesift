import type { CdpCallFrame } from "../app/js-profiler/types";

/**
 * React reconciler, renderer, and scheduler internals. Their sampled cost is
 * real, but it is not work a product developer can change: a card about
 * reconcileChildFibersImpl or commitMutationEffects tells nobody what to fix.
 * A bottleneck made up entirely of these frames is dropped before analysis.
 *
 * Only unmistakably framework-owned names belong here. Anything a product
 * function could plausibly be called must stay out, so application work is
 * never hidden.
 */
const internalNames = new Set([
  // Work loop and root scheduling
  "performWorkOnRoot", "performWorkOnRootViaSchedulerTask",
  "performSyncWorkOnRoot", "performConcurrentWorkOnRoot",
  "renderRootSync", "renderRootConcurrent", "workLoopSync", "workLoopConcurrent",
  "performUnitOfWork", "prepareFreshStack", "completeRoot", "flushSyncCallbacks",
  "flushSyncWorkOnAllRoots", "flushSyncWork", "flushSyncWorkAcrossRoots",
  "flushSyncWorkAcrossRoots_impl", "processRootScheduleInMicrotask",
  "ensureRootIsScheduled", "requestUpdateLane", "markRootUpdated", "throwException",
  // The batching entry points the renderer wraps a host event in. Dev builds of
  // React Native record these with no URL at all, which files them under the
  // engine — and now that a built-in which names itself is drawn, an unlisted
  // `batchedUpdatesImpl` would be drawn with it.
  "batchedUpdates", "batchedUpdatesImpl", "discreteUpdates",
  // The event system between a host event and the handler the product wrote.
  // These are listed by name because the module heuristic below cannot see
  // them: a Metro or webpack bundle gives every frame in the app one URL, so
  // `dispatchEvent` out of `expo-router/entry.bundle` is indistinguishable by
  // path from a component. Left unlisted it classifies as the product's own
  // code, and since it sits above every handler it becomes the outermost named
  // frame on the stack — the boundary search stops there and one wrapper is
  // drawn holding 100% of the task, with `_onFocus` and every other feature
  // hidden inside it. `prompts.ts` already excludes these from a card title
  // for the same reason; this is that knowledge moved to where the tree is cut.
  "dispatchEvent", "dispatchEventForPluginEventSystem", "dispatchEventsForPlugins",
  "dispatchEventsForPluginEventSystem", "dispatchDiscreteEvent", "dispatchContinuousEvent",
  "executeDispatch", "executeDispatchesInOrder", "executeDispatchesAndReleaseTopLevel",
  "processDispatchQueue", "processDispatchQueueItemsInOrder", "forEachAccumulated",
  "runWithFiberInDEV",
  // Render phase
  "beginWork", "completeWork", "completeUnitOfWork", "unwindWork", "bubbleProperties",
  "renderWithHooks", "finishRenderingHooks", "finishClassComponent", "appendAllChildren",
  // beginWork's dispatch arms. These sit between the scheduler and the component,
  // so leaving them out made them look like the outermost application frame and
  // every rendered component collapsed into one "updateFunctionComponent" group.
  "updateFunctionComponent", "updateForwardRef", "updateClassComponent",
  "updateSimpleMemoComponent", "updateMemoComponent", "updateHostRoot", "updateHostComponent",
  "updateContextProvider", "updateContextConsumer", "updateSuspenseComponent",
  "updateOffscreenComponent", "updateLazyComponent", "mountLazyComponent",
  "mountIndeterminateComponent", "attemptEarlyBailoutIfNoScheduledUpdate",
  "checkScheduledUpdateOrContext", "bailoutOnAlreadyFinishedWork", "bailoutHooks",
  "reconcileChildren", "reconcileChildrenArray", "reconcileSingleElement",
  "createChildReconciler", "mapRemainingChildren", "updateSlot", "updateFromMap", "placeChild",
  // Commit phase
  "commitRoot", "commitRootImpl", "commitRootWhenReady", "commitMutationEffects",
  "commitMutationEffectsOnFiber", "commitBeforeMutationEffects", "commitReconciliationEffects",
  "commitLayoutEffects", "commitLayoutEffectOnFiber", "commitPassiveMountEffects",
  "commitPassiveUnmountEffects", "commitPassiveMountOnFiber", "commitHookEffectListMount",
  "commitHookEffectListUnmount", "commitHookLayoutEffects", "commitHookLayoutUnmountEffects",
  "commitHookPassiveMountEffects", "commitHookPassiveUnmountEffects",
  "commitPassiveUnmountEffectsInsideOfDeletedTree", "commitOffscreenPassiveMountEffects",
  "commitCachePassiveMountEffect", "commitDoubleInvokeEffectsInDEV", "commitAttachRef",
  "commitClassCallbacks", "commitClassSnapshot", "commitHiddenCallbacks",
  "flushPassiveEffects", "flushPassiveEffectsImpl",
  // React 19 splits the commit into discrete flush steps driven by flushPendingEffects.
  "flushPendingEffects", "flushMutationEffects", "flushLayoutEffects", "flushSpawnedWork",
  "safelyCallDestroy", "invokeGuardedCallback", "invokeGuardedCallbackImpl",
  // Hooks and state dispatch
  "mountState", "mountReducer", "updateState", "updateReducer", "updateReducerImpl",
  "mountWorkInProgressHook", "updateWorkInProgressHook",
  "dispatchAction", "dispatchSetState", "dispatchSetStateInternal", "dispatchReducerAction",
  // Scheduler package
  "flushWork", "workLoop", "performWorkUntilDeadline", "requestHostCallback",
  "schedulePerformWorkUntilDeadline", "advanceTimers", "handleTimeout", "runWithPriority",
]);

/** React's dev builds suffix module-scoped duplicates, e.g. `beginWork$1`. */
const devSuffix = /\$\d+$/;

/** Names no application function realistically uses. */
const internalNamePatterns = [/Fiber/, /^recursivelyTraverse/, /^unstable_/];

/** Only the renderer/reconciler/scheduler packages, not every framework module. */
const internalModules =
  /node_modules[\\/](?:react|react-dom|react-reconciler|scheduler)[\\/]|react-native[\\/]Libraries[\\/]Renderer[\\/]/i;

export function isFrameworkInternalFrame(frame: CdpCallFrame): boolean {
  const name = frame.functionName.replace(devSuffix, "");
  if (name && (internalNames.has(name) || internalNamePatterns.some((pattern) => pattern.test(name)))) return true;
  return Boolean(frame.url) && internalModules.test(frame.url);
}
