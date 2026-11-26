package com.tracesift.profiler

import com.facebook.hermes.instrumentation.HermesSamplingProfiler
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.File

/** The same profiler, driven from JS instead of from the CLI. */
class TracesiftProfilerModule(
  private val reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext) {
  override fun getName() = NAME

  @ReactMethod(isBlockingSynchronousMethod = true)
  fun startProfiling(): Boolean {
    HermesSamplingProfiler.enable()
    return true
  }

  /** Resolves with the path of the written profile. */
  @ReactMethod
  fun stopProfiling(promise: Promise) {
    try {
      val file = File.createTempFile("tracesift-profile", ".cpuprofile", reactContext.cacheDir)
      HermesSamplingProfiler.dumpSampledTraceToFile(file.path)
      HermesSamplingProfiler.disable()
      promise.resolve(file.path)
    } catch (error: Throwable) {
      promise.reject("tracesift_profiler", error.message, error)
    }
  }

  companion object {
    const val NAME = "TracesiftProfiler"
  }
}
