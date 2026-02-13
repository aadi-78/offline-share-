package com.seven1111.offshare

import android.net.Uri
import android.util.Log
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.File
import java.io.FileInputStream
import java.io.InputStream

class SafTransferModule(private val ctx: ReactApplicationContext) :
    ReactContextBaseJavaModule(ctx) {

    companion object {
        private const val TAG = "SafTransfer"
        private const val COPY_BUFFER_SIZE = 256 * 1024
    }

    override fun getName() = "SafTransfer"

    @ReactMethod
    fun copyFileToContentUri(sourceUri: String, destContentUri: String, promise: Promise) {
        try {
            val contentResolver = ctx.applicationContext.contentResolver
            val destination = Uri.parse(destContentUri)

            if (destination.scheme != "content") {
                promise.reject(
                    "INVALID_DEST_URI",
                    "Destination must be a content:// URI. Got: $destContentUri"
                )
                return
            }

            val inputStream = openSourceInputStream(sourceUri)
                ?: run {
                    promise.reject("SOURCE_OPEN_FAILED", "Could not open source URI: $sourceUri")
                    return
                }

            contentResolver.openOutputStream(destination, "w").use { output ->
                if (output == null) {
                    promise.reject("DEST_OPEN_FAILED", "Could not open destination URI: $destContentUri")
                    return
                }

                inputStream.use { input ->
                    val buffer = ByteArray(COPY_BUFFER_SIZE)
                    var bytesCopied = 0L

                    while (true) {
                        val read = input.read(buffer)
                        if (read <= 0) break
                        output.write(buffer, 0, read)
                        bytesCopied += read
                    }

                    output.flush()
                    Log.d(TAG, "Copied $bytesCopied bytes from $sourceUri to $destContentUri")
                    promise.resolve(bytesCopied.toDouble())
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "copyFileToContentUri failed", e)
            promise.reject("SAF_COPY_FAILED", "Failed to copy file to SAF URI: ${e.message}", e)
        }
    }

    private fun openSourceInputStream(sourceUri: String): InputStream? {
        val resolver = ctx.applicationContext.contentResolver
        val parsed = Uri.parse(sourceUri)

        if (parsed.scheme == "content") {
            return resolver.openInputStream(parsed)
        }

        // For file:// URIs, Android may return percent-encoded paths (e.g. %2C for comma).
        // Try multiple candidates to avoid ENOENT on encoded temp-file names.
        val candidates = linkedSetOf<String>()

        if (parsed.scheme == "file") {
            parsed.path?.let { candidates.add(it) }
            parsed.encodedPath?.let { candidates.add(Uri.decode(it)) }
        }

        val rawPath = sourceUri.removePrefix("file://")
        candidates.add(rawPath)
        candidates.add(Uri.decode(rawPath))

        for (path in candidates) {
            val file = File(path)
            if (file.exists() && file.isFile) {
                return FileInputStream(file)
            }
        }

        val debugPaths = candidates.joinToString(" | ")
        Log.e(TAG, "Source file not found. Tried: $debugPaths")
        return null
    }

    @ReactMethod
    fun addListener(eventName: String) {
        // Required for RN event emitters
    }

    @ReactMethod
    fun removeListeners(count: Int) {
        // Required for RN event emitters
    }
}
