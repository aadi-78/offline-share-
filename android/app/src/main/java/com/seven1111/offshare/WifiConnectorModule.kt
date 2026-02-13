package com.seven1111.offshare

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.wifi.WifiNetworkSpecifier
import android.os.Build
import android.location.LocationManager
import android.Manifest
import android.content.pm.PackageManager
import android.util.Log
import androidx.annotation.RequiresApi
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.*

class WifiConnectorModule(private val ctx: ReactApplicationContext) :
    ReactContextBaseJavaModule(ctx) {

    private var networkCallback: ConnectivityManager.NetworkCallback? = null
    private var boundNetwork: Network? = null

    companion object {
        private const val TAG = "WifiConnector"
        private const val CONNECT_TIMEOUT_MS = 30000L // 30 seconds
    }

    override fun getName() = "WifiConnector"

    private fun hasPermission(permission: String): Boolean {
        return ContextCompat.checkSelfPermission(ctx, permission) == PackageManager.PERMISSION_GRANTED
    }

    private fun isLocationServicesEnabled(): Boolean {
        return try {
            val lm = ctx.applicationContext.getSystemService(Context.LOCATION_SERVICE) as LocationManager
            lm.isProviderEnabled(LocationManager.GPS_PROVIDER) ||
                lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER)
        } catch (e: Exception) {
            false
        }
    }

    /**
     * Programmatically connects to a Wi-Fi hotspot using WifiNetworkSpecifier (Android 10+).
     * After connecting, binds the entire process to that network so all HTTP traffic
     * (fetch, etc.) goes through Wi-Fi — not mobile data.
     */
    @RequiresApi(Build.VERSION_CODES.Q)
    @ReactMethod
    fun connectToHotspot(ssid: String, password: String, promise: Promise) {
        try {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
                promise.reject("UNSUPPORTED_ANDROID_VERSION",
                    "Hotspot join requires Android 10 (API 29) or higher.")
                return
            }

            val missingPerms = mutableListOf<String>()
            if (!hasPermission(Manifest.permission.ACCESS_FINE_LOCATION)) {
                missingPerms.add("ACCESS_FINE_LOCATION")
            }
            if (!hasPermission(Manifest.permission.ACCESS_COARSE_LOCATION)) {
                missingPerms.add("ACCESS_COARSE_LOCATION")
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
                !hasPermission(Manifest.permission.NEARBY_WIFI_DEVICES)
            ) {
                missingPerms.add("NEARBY_WIFI_DEVICES")
            }

            if (missingPerms.isNotEmpty()) {
                val missing = missingPerms.joinToString(", ")
                Log.e(TAG, "Missing required permissions: $missing")
                promise.reject("MISSING_WIFI_PERMISSIONS",
                    "Missing permissions for hotspot join: $missing")
                return
            }

            if (!isLocationServicesEnabled()) {
                Log.e(TAG, "Location Services are OFF")
                promise.reject("LOCATION_SERVICES_OFF",
                    "Location Services are OFF. Turn on Location and try again.")
                return
            }

            val cm = ctx.applicationContext.getSystemService(Context.CONNECTIVITY_SERVICE)
                as ConnectivityManager

            // Clean up any previous callback
            cleanupCallback(cm)

            Log.d(TAG, "Requesting connection to SSID: $ssid")

            val specifier = WifiNetworkSpecifier.Builder()
                .setSsid(ssid)
                .setWpa2Passphrase(password)
                .build()

            val request = NetworkRequest.Builder()
                .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
                .removeCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                .setNetworkSpecifier(specifier)
                .build()

            var promiseResolved = false

            // Create a timeout handler
            val handler = android.os.Handler(android.os.Looper.getMainLooper())
            val timeoutRunnable = Runnable {
                if (!promiseResolved) {
                    promiseResolved = true
                    Log.e(TAG, "Connection timed out after ${CONNECT_TIMEOUT_MS}ms")
                    cleanupCallback(cm)
                    promise.reject("CONNECTION_TIMEOUT",
                        "Timed out connecting to hotspot '$ssid'. Make sure the sender's hotspot is active.")
                }
            }

            networkCallback = object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) {
                    if (promiseResolved) return
                    promiseResolved = true
                    handler.removeCallbacks(timeoutRunnable)

                    Log.d(TAG, "Network available — binding process to network")
                    val bound = cm.bindProcessToNetwork(network)
                    boundNetwork = network
                    Log.d(TAG, "bindProcessToNetwork result: $bound")

                    if (bound) {
                        promise.resolve("CONNECTED")
                    } else {
                        promise.reject("BIND_FAILED",
                            "Connected to Wi-Fi but failed to bind process to network")
                    }
                }

                override fun onUnavailable() {
                    if (promiseResolved) return
                    promiseResolved = true
                    handler.removeCallbacks(timeoutRunnable)

                    Log.e(TAG, "Network unavailable — connection rejected or cancelled by user")
                    promise.reject("CONNECTION_FAILED",
                        "Could not connect to hotspot '$ssid'. Check SSID/password or try again.")
                }

                override fun onLost(network: Network) {
                    Log.w(TAG, "Network lost — Wi-Fi disconnected")
                    boundNetwork = null
                }

                override fun onCapabilitiesChanged(
                    network: Network,
                    networkCapabilities: NetworkCapabilities
                ) {
                    Log.d(TAG, "Network capabilities changed: $networkCapabilities")
                }
            }

            // Start the timeout
            handler.postDelayed(timeoutRunnable, CONNECT_TIMEOUT_MS)

            // Request the network (this shows the system UI for the user to approve)
            cm.requestNetwork(request, networkCallback!!)
            Log.d(TAG, "Network request submitted")

        } catch (e: SecurityException) {
            Log.e(TAG, "SecurityException while requesting Wi-Fi network", e)
            promise.reject("WIFI_SECURITY_EXCEPTION",
                "Android blocked hotspot join. Keep OffShare in foreground, ensure Location Services are ON, and grant Nearby Devices + Location. Details: ${e.message}")
        } catch (e: Exception) {
            Log.e(TAG, "Error connecting to hotspot", e)
            promise.reject("CONNECT_ERROR", "Failed to connect: ${e.message}")
        }
    }

    /**
     * Clears the network binding so the process returns to default routing
     * (i.e. mobile data or whatever the system prefers).
     * Must be called after transfer completes.
     */
    @ReactMethod
    fun clearNetworkBinding(promise: Promise) {
        try {
            val cm = ctx.applicationContext.getSystemService(Context.CONNECTIVITY_SERVICE)
                as ConnectivityManager

            cm.bindProcessToNetwork(null)
            boundNetwork = null
            cleanupCallback(cm)

            Log.d(TAG, "Network binding cleared — process returned to default routing")
            promise.resolve(true)
        } catch (e: Exception) {
            Log.e(TAG, "Error clearing network binding", e)
            promise.reject("CLEAR_ERROR", "Failed to clear binding: ${e.message}")
        }
    }

    /**
     * Returns whether we currently have a bound Wi-Fi network.
     */
    @ReactMethod
    fun isNetworkBound(promise: Promise) {
        promise.resolve(boundNetwork != null)
    }

    /**
     * Clean up any existing network callback to avoid leaks.
     */
    private fun cleanupCallback(cm: ConnectivityManager) {
        networkCallback?.let {
            try {
                cm.unregisterNetworkCallback(it)
                Log.d(TAG, "Previous network callback unregistered")
            } catch (e: Exception) {
                // Callback may not have been registered yet, that's fine
                Log.d(TAG, "No previous callback to unregister: ${e.message}")
            }
        }
        networkCallback = null
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
