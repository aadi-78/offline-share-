package com.seven1111.offshare

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.Settings
import android.util.Log
import com.facebook.react.bridge.*
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.google.android.gms.nearby.Nearby
import com.google.android.gms.nearby.connection.*
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.io.FileNotFoundException
import java.io.FileOutputStream
import java.nio.charset.StandardCharsets

class NearbyManager(private val reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {

    private val connectionsClient = Nearby.getConnectionsClient(reactContext)
    private val strategy = Strategy.P2P_CLUSTER
    private val endpointMap = mutableMapOf<String, String>() // specific mapping if needed
    private val payloadMap = mutableMapOf<Long, Payload>()
    private val filenameMap = mutableMapOf<Long, String>() // specific filename mapping for incoming payloads

    override fun getName(): String {
        return "NearbyManager"
    }

    private fun sendEvent(eventName: String, params: WritableMap?) {
        reactContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit(eventName, params)
    }

    @ReactMethod
    fun startAdvertising(deviceName: String, promise: Promise) {
        val advertisingOptions = AdvertisingOptions.Builder().setStrategy(strategy).build()
        connectionsClient.startAdvertising(
            deviceName,
            "com.seven1111.offshare", // Service ID
            connectionLifecycleCallback,
            advertisingOptions
        )
            .addOnSuccessListener {
                promise.resolve(null)
            }
            .addOnFailureListener { e ->
                promise.reject("ADVERTISING_FAILED", e)
            }
    }

    @ReactMethod
    fun startDiscovery(promise: Promise) {
        val discoveryOptions = DiscoveryOptions.Builder().setStrategy(strategy).build()
        connectionsClient.startDiscovery(
            "com.seven1111.offshare",
            endpointDiscoveryCallback,
            discoveryOptions
        )
            .addOnSuccessListener {
                promise.resolve(null)
            }
            .addOnFailureListener { e ->
                promise.reject("DISCOVERY_FAILED", e)
            }
    }

    @ReactMethod
    fun requestConnection(endpointId: String, deviceName: String, promise: Promise) {
        connectionsClient.requestConnection(deviceName, endpointId, connectionLifecycleCallback)
            .addOnSuccessListener {
                promise.resolve(null)
            }
            .addOnFailureListener { e ->
                promise.reject("CONNECTION_REQUEST_FAILED", e)
            }
    }

    @ReactMethod
    fun acceptConnection(endpointId: String, promise: Promise) {
        connectionsClient.acceptConnection(endpointId, payloadCallback)
            .addOnSuccessListener {
                promise.resolve(null)
            }
            .addOnFailureListener { e ->
                promise.reject("ACCEPT_CONNECTION_FAILED", e)
            }
    }

    @ReactMethod
    fun rejectConnection(endpointId: String, promise: Promise) {
        connectionsClient.rejectConnection(endpointId)
            .addOnSuccessListener {
                promise.resolve(null)
            }
            .addOnFailureListener { e ->
                promise.reject("REJECT_CONNECTION_FAILED", e)
            }
    }

    @ReactMethod
    fun disconnect(endpointId: String) {
        connectionsClient.disconnectFromEndpoint(endpointId)
        val params = Arguments.createMap()
        params.putString("endpointId", endpointId)
        sendEvent("onDisconnected", params)
    }

    @ReactMethod
    fun stopAll() {
        connectionsClient.stopAdvertising()
        connectionsClient.stopDiscovery()
        connectionsClient.stopAllEndpoints()
        filenameMap.clear()
        payloadMap.clear()
    }

    @ReactMethod
    fun sendFile(endpointId: String, filePath: String, promise: Promise) {
        try {
            val file = File(filePath)
            if (!file.exists()) {
                promise.reject("FILE_NOT_FOUND", "File does not exist: $filePath")
                return
            }

            // 1. Create File Payload
            val filePayload = Payload.fromFile(file)
            val filePayloadId = filePayload.id

            // 2. Create Metadata Payload
            val metadata = JSONObject()
            metadata.put("type", "metadata")
            metadata.put("fileName", file.name)
            metadata.put("fileSize", file.length())
            metadata.put("mimeType", "application/octet-stream") // Or detect mime type
            metadata.put("payloadId", filePayloadId)

            val metaPayload = Payload.fromBytes(metadata.toString().toByteArray(StandardCharsets.UTF_8))

            // 3. Send Metadata
            connectionsClient.sendPayload(endpointId, metaPayload)
                .addOnFailureListener { e -> Log.e("NearbyManager", "Failed to send metadata", e) }

            // 4. Send File
            connectionsClient.sendPayload(endpointId, filePayload)
                .addOnSuccessListener {
                    promise.resolve(filePayloadId.toString())
                }
                .addOnFailureListener { e ->
                    promise.reject("SEND_FILE_FAILED", e)
                }

        } catch (e: Exception) {
            promise.reject("SEND_ERROR", e)
        }
    }

    // Callbacks

    private val connectionLifecycleCallback = object : ConnectionLifecycleCallback() {
        override fun onConnectionInitiated(endpointId: String, connectionInfo: ConnectionInfo) {
            val params = Arguments.createMap()
            params.putString("endpointId", endpointId)
            params.putString("endpointName", connectionInfo.endpointName)
            params.putString("authenticationToken", connectionInfo.authenticationToken)
            params.putBoolean("isIncomingConnection", connectionInfo.isIncomingConnection)
            sendEvent("onConnectionInitiated", params)
        }

        override fun onConnectionResult(endpointId: String, result: ConnectionResolution) {
            val params = Arguments.createMap()
            params.putString("endpointId", endpointId)
            
            when (result.status.statusCode) {
                ConnectionsStatusCodes.STATUS_OK -> {
                    params.putString("status", "CONNECTED")
                    sendEvent("onConnectionResult", params)
                }
                ConnectionsStatusCodes.STATUS_CONNECTION_REJECTED -> {
                    params.putString("status", "REJECTED")
                    sendEvent("onConnectionResult", params)
                }
                ConnectionsStatusCodes.STATUS_ERROR -> {
                    params.putString("status", "ERROR")
                    sendEvent("onConnectionResult", params)
                }
                else -> {
                    params.putString("status", "UNKNOWN")
                    sendEvent("onConnectionResult", params)
                }
            }
        }

        override fun onDisconnected(endpointId: String) {
            val params = Arguments.createMap()
            params.putString("endpointId", endpointId)
            sendEvent("onDisconnected", params)
        }
    }

    private val endpointDiscoveryCallback = object : EndpointDiscoveryCallback() {
        override fun onEndpointFound(endpointId: String, info: DiscoveredEndpointInfo) {
            val params = Arguments.createMap()
            params.putString("endpointId", endpointId)
            params.putString("endpointName", info.endpointName)
            params.putString("serviceId", info.serviceId)
            sendEvent("onEndpointFound", params)
        }

        override fun onEndpointLost(endpointId: String) {
            val params = Arguments.createMap()
            params.putString("endpointId", endpointId)
            sendEvent("onEndpointLost", params)
        }
    }

    private val payloadCallback = object : PayloadCallback() {
        override fun onPayloadReceived(endpointId: String, payload: Payload) {
            if (payload.type == Payload.Type.BYTES) {
                val bytes = payload.asBytes()
                if (bytes != null) {
                    val metadataJson = String(bytes, StandardCharsets.UTF_8)
                    try {
                        val metadata = JSONObject(metadataJson)
                        if (metadata.has("type") && metadata.getString("type") == "metadata") {
                            val payloadId = metadata.getLong("payloadId")
                            val fileName = metadata.getString("fileName")
                            filenameMap[payloadId] = fileName
                            
                             // Emit event to JS to prepare for file
                            val params = Arguments.createMap()
                            params.putString("type", "metadata")
                            params.putString("endpointId", endpointId)
                            params.putString("filePayloadId", payloadId.toString())
                            params.putString("fileName", fileName)
                            params.putString("fileSize", metadata.optString("fileSize", "0"))
                            sendEvent("onPayloadReceived", params)
                        }
                    } catch (e: Exception) {
                        Log.e("NearbyManager", "Invalid metadata JSON", e)
                    }
                }
            } else if (payload.type == Payload.Type.FILE) {
                val payloadId = payload.id
                val fileName = filenameMap[payloadId] ?: "unknown_file_${System.currentTimeMillis()}"
                
                // The file needs to be moved/renamed after transfer completion.
                // For now, we emit that we started receiving a file.
                 val params = Arguments.createMap()
                params.putString("type", "file_start")
                params.putString("endpointId", endpointId)
                params.putString("payloadId", payloadId.toString())
                params.putString("fileName", fileName)
                sendEvent("onPayloadReceived", params)
                
                payloadMap[payloadId] = payload
            }
        }

        override fun onPayloadTransferUpdate(endpointId: String, update: PayloadTransferUpdate) {
            val params = Arguments.createMap()
            params.putString("endpointId", endpointId)
            params.putString("payloadId", update.payloadId.toString())
            params.putDouble("bytesTransferred", update.bytesTransferred.toDouble())
            params.putDouble("totalBytes", update.totalBytes.toDouble())
            
            when (update.status) {
                PayloadTransferUpdate.Status.IN_PROGRESS -> params.putString("status", "IN_PROGRESS")
                PayloadTransferUpdate.Status.SUCCESS -> {
                    params.putString("status", "SUCCESS")
                    val payloadId = update.payloadId
                    val payload = payloadMap[payloadId]
                    val fileName = filenameMap[payloadId]
                    
                    if (fileName != null) {
                        params.putString("fileName", fileName)
                    }
                    
                    if (payload != null && payload.type == Payload.Type.FILE) {
                        params.putString("payloadType", "FILE")
                        val nearbyFile = payload.asFile()?.asJavaFile()
                        
                        if (nearbyFile != null && nearbyFile.exists()) {
                            // Copy from restricted .nearby dir to app's cache dir
                            val targetName = fileName ?: "received_${System.currentTimeMillis()}"
                            val cacheDir = File(reactContext.cacheDir, "nearby_received")
                            cacheDir.mkdirs()
                            val cacheFile = File(cacheDir, targetName)
                            
                            try {
                                FileInputStream(nearbyFile).use { input ->
                                    FileOutputStream(cacheFile).use { output ->
                                        val buffer = ByteArray(256 * 1024)
                                        var bytesRead: Int
                                        while (input.read(buffer).also { bytesRead = it } > 0) {
                                            output.write(buffer, 0, bytesRead)
                                        }
                                        output.flush()
                                    }
                                }
                                params.putString("filePath", cacheFile.absolutePath)
                                Log.d("NearbyManager", "File copied to cache: ${cacheFile.absolutePath}")
                                
                                // Clean up the original .nearby file
                                nearbyFile.delete()
                            } catch (e: Exception) {
                                Log.e("NearbyManager", "Failed to copy file to cache", e)
                                // Fallback: try passing original path anyway
                                params.putString("filePath", nearbyFile.absolutePath)
                            }
                        } else {
                            Log.w("NearbyManager", "File transfer SUCCESS but file not found or null")
                        }
                    } else {
                        // BYTES payload or unknown — mark it so JS can skip
                        params.putString("payloadType", "BYTES")
                    }
                }
                PayloadTransferUpdate.Status.FAILURE -> params.putString("status", "FAILURE")
                PayloadTransferUpdate.Status.CANCELED -> params.putString("status", "CANCELED")
                else -> params.putString("status", "UNKNOWN")
            }
            
            sendEvent("onPayloadTransferUpdate", params)
            
            if (update.status == PayloadTransferUpdate.Status.SUCCESS || 
                update.status == PayloadTransferUpdate.Status.FAILURE || 
                update.status == PayloadTransferUpdate.Status.CANCELED) {
                 payloadMap.remove(update.payloadId)
                 filenameMap.remove(update.payloadId)
            }
        }
    }
    
    // ─── All Files Access (MANAGE_EXTERNAL_STORAGE) ─────────────
    @ReactMethod
    fun isAllFilesAccessGranted(promise: Promise) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            promise.resolve(Environment.isExternalStorageManager())
        } else {
            // Android 10 and below: requestLegacyExternalStorage handles it
            promise.resolve(true)
        }
    }

    @ReactMethod
    fun requestAllFilesAccess() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && !Environment.isExternalStorageManager()) {
            try {
                val intent = Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION)
                intent.data = Uri.parse("package:" + reactContext.packageName)
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                reactContext.startActivity(intent)
            } catch (e: Exception) {
                Log.e("NearbyManager", "Failed to open All Files Access settings", e)
                // Fallback to general settings
                val intent = Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION)
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                reactContext.startActivity(intent)
            }
        }
    }

    // Required for EventEmitter
    @ReactMethod
    fun addListener(eventName: String) {
        // Keep: Required for RN built-in Event Emitter Calls.
    }

    @ReactMethod
    fun removeListeners(count: Int) {
        // Keep: Required for RN built-in Event Emitter Calls.
    }
}
