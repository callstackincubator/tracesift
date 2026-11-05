package com.tracesift.profiler

import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.content.pm.PackageManager
import android.database.Cursor
import android.net.Uri
import android.util.Log

/**
 * Starts profiling without the app having to call anything.
 *
 * A `ContentProvider` is Android's earliest third-party entry point — it runs
 * before `Application.onCreate` and needs no app code, no `index.js` import
 * and no React context. That matters for two reasons: the integration stays a
 * dependency and nothing else, and the sampler can be armed early enough to
 * see startup.
 *
 * It is **off unless a build asks for it**. A release binary that opens a
 * control socket for the asking is a remote-profiling backdoor, so enabling
 * it is a build-time decision: this package's manifest declares the meta-data
 * below from a placeholder that resolves to false unless the build passes
 * `-PtracesiftProfiler=true`. Reading it costs one bundle lookup, and without
 * it no socket is ever opened.
 */
class ProfilerInitProvider : ContentProvider() {
  override fun onCreate(): Boolean {
    val context = context ?: return false
    val meta = try {
      context.packageManager
        .getApplicationInfo(context.packageName, PackageManager.GET_META_DATA)
        .metaData
    } catch (error: PackageManager.NameNotFoundException) {
      null
    }

    if (meta == null || !meta.getBoolean(ENABLED_KEY, false)) return false

    val port = meta.getInt(PORT_KEY, DEFAULT_PORT)
    Log.i(ProfilerLink.TAG, "profiling enabled; dialling the tracesift CLI on port $port")
    ProfilerLink.start(context.applicationContext, port)
    return false
  }

  // A provider is the hook, not a data source. Nothing here is reachable:
  // the manifest declares it android:exported="false".
  override fun query(uri: Uri, p: Array<String>?, s: String?, a: Array<String>?, o: String?): Cursor? = null
  override fun getType(uri: Uri): String? = null
  override fun insert(uri: Uri, values: ContentValues?): Uri? = null
  override fun delete(uri: Uri, s: String?, a: Array<String>?): Int = 0
  override fun update(uri: Uri, v: ContentValues?, s: String?, a: Array<String>?): Int = 0

  companion object {
    const val ENABLED_KEY = "com.tracesift.profiler.enabled"
    const val PORT_KEY = "com.tracesift.profiler.port"
    const val DEFAULT_PORT = 8089
  }
}
