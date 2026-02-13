package com.seven1111.offshare

import android.content.Intent
import android.media.MediaScannerConnection
import android.net.Uri
import android.util.Log
import com.facebook.react.bridge.*

class MediaScannerModule(private val ctx: ReactApplicationContext) :
    ReactContextBaseJavaModule(ctx) {

    companion object {
        private const val TAG = "MediaScanner"
    }

    override fun getName() = "MediaScanner"

    /**
     * Triggers the Android MediaScanner on a file so it appears in
     * the system file manager, gallery, and other media apps.
     *
     * @param filePath Absolute path to the file (e.g. /storage/emulated/0/Download/OffShare/photo.jpg)
     */
    @ReactMethod
    fun scanFile(filePath: String, promise: Promise) {
        try {
            // Strip file:// prefix if present
            val cleanPath = filePath.replace("file://", "")

            Log.d(TAG, "Scanning file: $cleanPath")

            MediaScannerConnection.scanFile(
                ctx.applicationContext,
                arrayOf(cleanPath),
                null
            ) { path, uri ->
                Log.d(TAG, "Scan complete: $path -> $uri")
                promise.resolve(uri?.toString() ?: path)
            }
        } catch (e: Exception) {
            Log.e(TAG, "Scan failed for: $filePath", e)
            promise.reject("SCAN_ERROR", "Failed to scan file: ${e.message}")
        }
    }

    /**
     * Scan multiple files at once.
     *
     * @param filePaths ReadableArray of absolute file paths
     */
    @ReactMethod
    fun scanFiles(filePaths: ReadableArray, promise: Promise) {
        try {
            val paths = mutableListOf<String>()
            for (i in 0 until filePaths.size()) {
                val raw = filePaths.getString(i) ?: continue
                paths.add(raw.replace("file://", ""))
            }

            Log.d(TAG, "Scanning ${paths.size} files")

            MediaScannerConnection.scanFile(
                ctx.applicationContext,
                paths.toTypedArray(),
                null
            ) { path, uri ->
                Log.d(TAG, "Scanned: $path -> $uri")
            }

            // Resolve immediately — scanning happens asynchronously
            promise.resolve(paths.size)
        } catch (e: Exception) {
            Log.e(TAG, "Batch scan failed", e)
            promise.reject("SCAN_ERROR", "Failed to scan files: ${e.message}")
        }
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
