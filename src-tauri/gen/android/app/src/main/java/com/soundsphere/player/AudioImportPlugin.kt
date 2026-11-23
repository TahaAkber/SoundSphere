package com.soundsphere.player

import android.app.Activity
import android.net.Uri
import android.provider.OpenableColumns
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.util.UUID
import java.util.concurrent.Executors

@InvokeArg
class CopyAudioFileArgs {
  lateinit var uri: String
}

@TauriPlugin
class AudioImportPlugin(private val activity: Activity) : Plugin(activity) {
  companion object {
    private val importExecutor = Executors.newFixedThreadPool(2) { task ->
      Thread(task, "SoundSphereAudioImport").apply { isDaemon = true }
    }
  }

  @Command
  fun copyFile(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(CopyAudioFileArgs::class.java)
      importExecutor.execute {
        try {
          val result = JSObject()
          result.put("path", copyFile(Uri.parse(args.uri)))
          invoke.resolve(result)
        } catch (error: Exception) {
          invoke.reject(error.message ?: "Android could not import this audio file.")
        }
      }
    } catch (error: Exception) {
      invoke.reject(error.message ?: "Android could not import this audio file.")
    }
  }

  private fun copyFile(uri: Uri): String {
    require(uri.scheme == "content") { "Choose an audio file from the Android file picker." }
    val originalName = activity.contentResolver.query(
      uri,
      arrayOf(OpenableColumns.DISPLAY_NAME),
      null,
      null,
      null,
    )?.use { cursor ->
      if (cursor.moveToFirst()) cursor.getString(0) else null
    } ?: "audio"
    val safeName = originalName
      .substringAfterLast('/')
      .replace(Regex("[^A-Za-z0-9._-]"), "_")
      .takeLast(120)
      .ifBlank { "audio" }
    val directory = File(activity.filesDir, "imports").apply { mkdirs() }
    val destination = File(directory, "${UUID.randomUUID()}-$safeName")
    val input = activity.contentResolver.openInputStream(uri)
      ?: throw IOException("Android could not open the selected audio file.")

    try {
      input.use { source ->
        FileOutputStream(destination).use { output ->
          val buffer = ByteArray(64 * 1024)
          var total = 0L
          while (true) {
            val count = source.read(buffer)
            if (count < 0) break
            total += count
            if (total > 500L * 1024 * 1024) {
              throw IOException("Audio files larger than 500 MB cannot be imported.")
            }
            output.write(buffer, 0, count)
          }
          output.fd.sync()
        }
      }
    } catch (error: Exception) {
      destination.delete()
      throw error
    }
    return destination.absolutePath
  }
}
