package com.seven1111.offshare

import android.util.Log
import fi.iki.elonen.NanoHTTPD
import java.io.File
import java.io.FileInputStream
import java.net.URLDecoder
import org.json.JSONArray
import org.json.JSONObject

class FileServer(
    port: Int,
    private val files: List<File>,
    private val onReceiverConnected: (() -> Unit)? = null
) : NanoHTTPD(port) {

    companion object {
        private const val TAG = "FileServer"
    }

    private var receiverHasConnected = false

    override fun serve(session: IHTTPSession): Response {
        val uri = session.uri
        val params = session.parms ?: emptyMap()

        return when {
            uri == "/ping" -> {
                val json = JSONObject()
                json.put("status", "ok")
                newFixedLengthResponse(Response.Status.OK, "application/json", json.toString())
            }

            uri == "/files" -> {
                // Mark receiver as connected on first /files request
                if (!receiverHasConnected) {
                    receiverHasConnected = true
                    onReceiverConnected?.invoke()
                }
                serveFileList()
            }

            uri == "/download" -> {
                val rawName = params["name"]
                if (rawName.isNullOrEmpty()) {
                    Log.w(TAG, "/download — Missing 'name' parameter")
                    newFixedLengthResponse(
                        Response.Status.BAD_REQUEST,
                        "text/plain",
                        "Missing 'name' parameter"
                    )
                } else {
                    // Always URL-decode: receiver sends encoded names
                    // e.g. "cyberpunk%20car%20yellow.jpg" → "cyberpunk car yellow.jpg"
                    val decodedName = URLDecoder.decode(rawName, "UTF-8")
                    Log.d(TAG, "/download — raw='$rawName' decoded='$decodedName'")
                    serveFileDownload(decodedName)
                }
            }

            else -> {
                newFixedLengthResponse(
                    Response.Status.NOT_FOUND,
                    "text/plain",
                    "Not Found"
                )
            }
        }
    }

    private fun serveFileList(): Response {
        val jsonArray = JSONArray()
        for (file in files) {
            if (file.exists() && file.isFile) {
                val obj = JSONObject()
                obj.put("name", file.name)
                obj.put("size", file.length())
                jsonArray.put(obj)
            }
        }
        return newFixedLengthResponse(
            Response.Status.OK,
            "application/json",
            jsonArray.toString()
        )
    }

    private fun serveFileDownload(fileName: String): Response {
        // Debug: dump available files and requested name
        Log.d(TAG, "Available files:")
        files.forEach { Log.d(TAG, "  '${it.name}'") }
        Log.d(TAG, "Requested: '$fileName'")

        val file = files.find { it.name == fileName }

        if (file == null) {
            Log.w(TAG, "serveFileDownload — No matching file found for: '$fileName'")
            return newFixedLengthResponse(
                Response.Status.NOT_FOUND,
                "text/plain",
                "File not found: $fileName"
            )
        }

        if (!file.exists()) {
            Log.w(TAG, "serveFileDownload — File object found but file doesn't exist on disk: '${file.absolutePath}'")
            return newFixedLengthResponse(
                Response.Status.NOT_FOUND,
                "text/plain",
                "File not found on disk: $fileName"
            )
        }

        val fis = FileInputStream(file)
        val response = newFixedLengthResponse(
            Response.Status.OK,
            "application/octet-stream",
            fis,
            file.length()
        )
        response.addHeader("Content-Disposition", "attachment; filename=\"${file.name}\"")
        response.addHeader("Content-Length", file.length().toString())
        Log.d(TAG, "serveFileDownload — Serving '${file.name}' (${file.length()} bytes)")
        return response
    }
}
