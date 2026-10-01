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
