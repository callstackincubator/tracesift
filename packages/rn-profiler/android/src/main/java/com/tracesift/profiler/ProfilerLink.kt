package com.tracesift.profiler

import android.content.Context
import android.os.Build
import android.util.Base64
import android.util.Log
import com.facebook.hermes.instrumentation.HermesSamplingProfiler
import java.io.BufferedReader
import java.io.File
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.net.InetSocketAddress
import java.net.Socket
import org.json.JSONObject

/**
 * The link to the tracesift CLI.
 *
 * The app dials out rather than listening, which is both how React Native's
 * own inspector behaves and the only direction that works without asking for
 * a network permission or opening a port on the device. On an emulator or a
 * USB device `adb reverse tcp:8089 tcp:8089` points 127.0.0.1 back at the
 * developer's machine.
 *
 * The wire is newline-delimited JSON. There is no websocket handshake because
 * both ends are ours and the framing is one line per message.
 */
internal object ProfilerLink {
  const val TAG = "TracesiftProfiler"

  private const val RETRY_DELAY_MS = 2_000L
  // Base64 of a long profile runs to megabytes. The CLI rejects any single
  // line past 8 MB, so the payload is split well under that.
  private const val CHUNK_CHARS = 256 * 1024

  @Volatile private var started = false

  /**
   * Whether the sampler is running, and the reason nothing else may name
   * `HermesSamplingProfiler` speculatively.
   *
   * That class loads Hermes through SoLoader in a static initialiser. We run
   * from a ContentProvider, which Android creates *before*
   * `Application.onCreate`, where React Native initialises SoLoader — so
   * touching the class early throws `ExceptionInInitializerError`, and
   * Android then refuses to retry the initialiser for the life of the
   * process ("Rejecting re-init on previously-failed class"). One speculative
   * call at startup therefore makes profiling impossible until the app is
   * restarted. So the class is named only in response to a `start` or `stop`
   * from the CLI, both of which are a person acting on a running app, long
   * after SoLoader is up.
   */
  @Volatile private var sampling = false

  /** Begin dialling, retrying until the CLI is there. Safe to call twice. */
  @Synchronized
  fun start(context: Context, port: Int) {
    if (started) return
    started = true
    val appId = context.packageName
    val thread = Thread({ loop(context, appId, port) }, "tracesift-profiler")
    thread.isDaemon = true
    thread.start()
  }

  private fun loop(context: Context, appId: String, port: Int) {
    while (true) {
      try {
        Socket().use { socket ->
          socket.tcpNoDelay = true
          socket.connect(InetSocketAddress("127.0.0.1", port), 1_000)
          Log.i(TAG, "connected to the tracesift CLI on 127.0.0.1:$port")
          serve(context, socket, appId)
        }
      } catch (error: Throwable) {
        // Nothing is listening yet, or the recording ended and the CLI hung
        // up. Either way the next attempt is the whole recovery.
        Log.d(TAG, "not connected (${error.javaClass.simpleName}); retrying")
      }
      // Make sure a recording cut short by a dropped connection cannot leave
      // the sampler running. Only when one was actually started: see `sampling`
      // for why this must not touch the class otherwise.
      if (sampling) stopSampling()
      Thread.sleep(RETRY_DELAY_MS)
    }
  }

  private fun serve(context: Context, socket: Socket, appId: String) {
    val reader = BufferedReader(InputStreamReader(socket.getInputStream(), Charsets.UTF_8))
    val writer = OutputStreamWriter(socket.getOutputStream(), Charsets.UTF_8)

    fun send(message: JSONObject) {
      writer.write(message.toString())
      writer.write("\n")
      writer.flush()
    }

    send(
      JSONObject()
        .put("type", "hello")
        .put("app", appId)
        .put("platform", "android")
        .put("bundle", "index.android.bundle")
        .put("device", "${Build.MANUFACTURER} ${Build.MODEL}"),
    )

    while (true) {
      val line = reader.readLine() ?: return
      if (line.isBlank()) continue
      val message = runCatching { JSONObject(line) }.getOrNull() ?: continue
      val id = message.optInt("id", 0)
      when (message.optString("type")) {
        // `hz` is advisory and Android cannot honour it: the Java binding
        // exposes a bare `enable()`, so Hermes samples at its own ~100 Hz.
        // The C++ API the iOS side will use does take a frequency.
        "start" -> runCatching { startSampling() }
          .onFailure { send(errorFor(id, it)) }
        "stop" -> runCatching { dump(context) }
          .onSuccess { profile -> sendProfile(::send, id, profile) }
          .onFailure { send(errorFor(id, it)) }
      }
    }
  }

  /**
   * Hermes writes the profile to a file, so there is a round trip through the
   * cache directory. Dumping also clears the sampler's buffer, which is why
   * `disable` comes after and why a profile can only be collected once.
   */
  private fun dump(context: Context): String {
    if (!sampling) throw IllegalStateException("no profile was started")
    val file = File.createTempFile("tracesift-profile", ".cpuprofile", context.cacheDir)
    try {
      HermesSamplingProfiler.dumpSampledTraceToFile(file.path)
      sampling = false
      HermesSamplingProfiler.disable()
      return file.readText()
    } finally {
      file.delete()
    }
  }

  private fun startSampling() {
    HermesSamplingProfiler.enable()
    sampling = true
  }

  private fun stopSampling() {
    sampling = false
    runCatching { HermesSamplingProfiler.disable() }
      .onFailure { Log.w(TAG, "could not stop the sampler", it) }
  }

  private fun sendProfile(send: (JSONObject) -> Unit, id: Int, profile: String) {
    val encoded = Base64.encodeToString(profile.toByteArray(Charsets.UTF_8), Base64.NO_WRAP)
    var sequence = 0
    var offset = 0
    do {
      val end = minOf(offset + CHUNK_CHARS, encoded.length)
      send(
        JSONObject()
          .put("type", "profile")
          .put("id", id)
          .put("seq", sequence)
          .put("data", encoded.substring(offset, end))
          .put("last", end >= encoded.length),
      )
      sequence += 1
      offset = end
    } while (offset < encoded.length)
  }

  private fun errorFor(id: Int, error: Throwable): JSONObject {
    Log.w(TAG, "profiling failed", error)
    return JSONObject()
      .put("type", "error")
      .put("id", id)
      .put("message", error.message ?: error.javaClass.name)
  }
}
