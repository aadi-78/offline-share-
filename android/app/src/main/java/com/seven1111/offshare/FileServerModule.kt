package com.seven1111.offshare

import com.facebook.react.bridge.*
import com.facebook.react.modules.core.DeviceEventManagerModule
import android.provider.Settings
import android.content.Intent
import android.content.Context
import android.util.Log
import java.io.File
import java.net.NetworkInterface

class FileServerModule(private val ctx: ReactApplicationContext) :
    ReactContextBaseJavaModule(ctx) {

    private var server: FileServer? = null

    companion object {
        private const val TAG = "FileServer"
    }

    override fun getName() = "FileServer"

    private fun sendEvent(eventName: String, params: WritableMap?) {
        ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit(eventName, params)
    }

    @ReactMethod
    fun startServer(port: Int, filePaths: ReadableArray, promise: Promise) {
        try {
            if (server != null) {
                server?.stop()
                server = null
            }

            val files = mutableListOf<File>()
            for (i in 0 until filePaths.size()) {
                val rawPath = filePaths.getString(i) ?: continue
                val cleanPath = rawPath.replace("file://", "")
                val file = File(cleanPath)
                if (file.exists() && file.isFile) {
                    files.add(file)
                }
            }

            if (files.isEmpty()) {
                promise.reject("NO_FILES", "No valid files found to serve. Paths received: ${filePaths.toArrayList()}")
                return
            }

            server = FileServer(port, files) {
                // Called when receiver connects (hits /files)
                val params = Arguments.createMap()
                params.putString("event", "receiverConnected")
                sendEvent("onReceiverConnected", params)
            }

            // Debug: log all files being served (paths should have NO %20)
            Log.d(TAG, "═══ Starting FileServer with ${files.size} files ═══")
            files.forEach { f ->
                Log.d(TAG, "  name='${f.name}' path='${f.absolutePath}' exists=${f.exists()}")
            }

            server?.start()

            val ip = getLocalIpAddress()
            val result = Arguments.createMap()
            result.putString("ip", ip)
            result.putInt("port", port)
            result.putBoolean("running", true)
            result.putInt("fileCount", files.size)
            promise.resolve(result)
        } catch (e: Exception) {
            promise.reject("SERVER_ERROR", "Failed to start server: ${e.message}")
        }
    }

    @ReactMethod
    fun stopServer(promise: Promise) {
        try {
            server?.stop()
            server = null
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("STOP_ERROR", "Failed to stop server: ${e.message}")
        }
    }

    // ─── Dynamic IPv4 Detection ──────────────────────────────────────
    // Prefer Wi-Fi/hotspot interfaces and private LAN ranges so QR advertises
    // a reachable sender address for receiver devices.

    private data class CandidateIp(
        val iface: String,
        val ip: String,
        val wifiLike: Boolean,
        val privateLan: Boolean
    )

    private fun isPrivateLanIp(ip: String): Boolean {
        if (ip.startsWith("192.168.")) return true
        if (ip.startsWith("10.")) return true
        if (ip.startsWith("172.")) {
            val parts = ip.split(".")
            if (parts.size >= 2) {
                val second = parts[1].toIntOrNull() ?: return false
                return second in 16..31
            }
        }
        return false
    }

    private fun isWifiLikeInterface(name: String): Boolean {
        val n = name.lowercase()
        return n.startsWith("wlan") || n.startsWith("swlan") || n.startsWith("ap") ||
            n.contains("wifi") || n.contains("softap") || n.startsWith("wl")
    }

    private fun isExcludedInterface(name: String): Boolean {
        val n = name.lowercase()
        return n.contains("rmnet") || n.contains("ccmni") || n.contains("pdp") ||
            n.contains("clat") || n.contains("tun") || n.contains("ppp") ||
            n.contains("dummy") || n.contains("lo")
    }

    private fun chooseBestLocalIpv4(): String? {
        val candidates = mutableListOf<CandidateIp>()
        val interfaces = NetworkInterface.getNetworkInterfaces()

        for (intf in interfaces) {
            val name = intf.name ?: continue
            if (!intf.isUp || intf.isLoopback || isExcludedInterface(name)) continue

            val addrs = intf.inetAddresses
            for (addr in addrs) {
                val ip = addr.hostAddress ?: continue
                if (addr.isLoopbackAddress || ip.contains(":")) continue
                if (!ip.matches(Regex("\\d+\\.\\d+\\.\\d+\\.\\d+"))) continue

                candidates.add(
                    CandidateIp(
                        iface = name,
                        ip = ip,
                        wifiLike = isWifiLikeInterface(name),
                        privateLan = isPrivateLanIp(ip)
                    )
                )
            }
        }

        val best =
            candidates.firstOrNull { it.wifiLike && it.privateLan }
                ?: candidates.firstOrNull { it.privateLan }
                ?: candidates.firstOrNull { it.wifiLike }
                ?: candidates.firstOrNull()

        best?.let {
            Log.d(TAG, "chooseBestLocalIpv4 — Selected ${it.ip} on ${it.iface} (wifiLike=${it.wifiLike}, privateLan=${it.privateLan})")
        }
        return best?.ip
    }

    @ReactMethod
    fun getLocalIPv4(promise: Promise) {
        try {
            val ip = chooseBestLocalIpv4()
            if (ip != null) {
                promise.resolve(ip)
                return
            }

            Log.w(TAG, "getLocalIPv4 — No suitable IPv4 found")
            promise.resolve(null)

        } catch (e: Exception) {
            Log.e(TAG, "getLocalIPv4 — Failed", e)
            promise.reject("IP_DETECTION_FAILED", e)
        }
    }

    // Debug method: returns ALL network interfaces with their IPs
    @ReactMethod
    fun dumpNetworkInterfaces(promise: Promise) {
        try {
            val result = Arguments.createArray()
            val interfaces = NetworkInterface.getNetworkInterfaces()

            for (intf in interfaces) {
                val name = intf.name ?: continue
                val addrs = intf.inetAddresses
                for (addr in addrs) {
                    val ip = addr.hostAddress ?: continue
                    if (ip.contains(":")) continue // skip IPv6

                    val entry = Arguments.createMap()
                    entry.putString("interface", name)
                    entry.putString("ip", ip)
                    entry.putBoolean("isUp", intf.isUp)
                    entry.putBoolean("isLoopback", intf.isLoopback)
                    result.pushMap(entry)
                }
            }
            promise.resolve(result)
        } catch (e: Exception) {
            promise.reject("DUMP_ERROR", e)
        }
    }

    // Internal helper used by startServer
    private fun getLocalIpAddress(): String {
        try {
            val ip = chooseBestLocalIpv4()
            if (ip != null) return ip
        } catch (e: Exception) {
            e.printStackTrace()
        }
        return "0.0.0.0"
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
