// The same profiler driven from JS, matching the Android TracesiftProfilerModule.
#import <React/RCTBridgeModule.h>

#include <hermes/hermes.h>

@interface TracesiftProfiler : NSObject <RCTBridgeModule>
@end

@implementation TracesiftProfiler

RCT_EXPORT_MODULE()

static facebook::hermes::IHermesRootAPI *Root(void) {
  auto *api = facebook::hermes::makeHermesRootAPI();
  return api ? facebook::jsi::castInterface<facebook::hermes::IHermesRootAPI>(api) : nullptr;
}

RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(startProfiling) {
  auto *root = Root();
  if (!root) return @NO;
  root->enableSamplingProfiler(1000);
  return @YES;
}

/// Resolves with the path of the written profile; the caller owns the file.
RCT_EXPORT_METHOD(stopProfiling : (RCTPromiseResolveBlock)resolve rejecter : (RCTPromiseRejectBlock)reject) {
  auto *root = Root();
  if (!root) {
    reject(@"tracesift_profiler", @"Hermes is not available", nil);
    return;
  }
  NSString *path = [NSTemporaryDirectory()
      stringByAppendingPathComponent:[NSString stringWithFormat:@"tracesift-profile-%@.cpuprofile", NSUUID.UUID.UUIDString]];
  root->dumpSampledTraceToFile(path.UTF8String);
  root->disableSamplingProfiler();
  resolve(path);
}

@end
