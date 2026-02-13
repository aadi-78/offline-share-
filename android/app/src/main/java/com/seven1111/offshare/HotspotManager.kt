package com.seven1111.offshare

import android.location.LocationManager
import android.net.wifi.WifiManager
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.Log
import com.facebook.react.bridge.*
import com.facebook.react.modules.core.DeviceEventManagerModule

class HotspotManager(private val ctx: ReactApplicationContext) :
    ReactContextBaseJavaModule(ctx) {

    private var hotspotReservation: WifiManager.LocalOnlyHotspotReservation? = null
    private val mainHandler = Handler(Looper.getMainLooper())

    companion object {
        private const val TAG = "HotspotManager"
    }

    override fun getName() = "HotspotManager"

    private fun sendEvent(eventName: String, params: WritableMap?) {
        ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit(eventName, params)
    }

    @ReactMethod
    fun startHotspot(promise: Promise) {
        try {
            val wifiManager = ctx.applicationContext.getSystemService(
                android.content.Context.WIFI_SERVICE
            ) as WifiManager

            Log.d(TAG, "Starting LocalOnlyHotspot...")

            wifiManager.startLocalOnlyHotspot(object : WifiManager.LocalOnlyHotspotCallback() {
                override fun onStarted(reservation: WifiManager.LocalOnlyHotspotReservation?) {
                    Log.d(TAG, "LocalOnlyHotspot onStarted callback fired")
                    hotspotReservation = reservation

                    // Wait 1500ms for the network interface to fully initialize
                    mainHandler.postDelayed({
                        try {
                            val config = reservation?.wifiConfiguration
                            val ssid = config?.SSID ?: "Unknown"
                            val password = config?.preSharedKey ?: ""

                            Log.d(TAG, "Hotspot ready — SSID: $ssid")

                            val result = Arguments.createMap()
                            result.putString("ssid", ssid)
                            result.putString("password", password)
                            result.putBoolean("active", true)

                            // Also fire an event for JS listeners
                            val eventParams = Arguments.createMap()
                            eventParams.putString("ssid", ssid)
                            eventParams.putString("password", password)
                            sendEvent("onHotspotStarted", eventParams)

                            promise.resolve(result)
                        } catch (e: Exception) {
                            Log.e(TAG, "Error reading hotspot config", e)
                            promise.reject("HOTSPOT_CONFIG_ERROR", e.message)
                        }
                    }, 1500)
                }

                override fun onStopped() {
                    Log.d(TAG, "LocalOnlyHotspot stopped")
                    hotspotReservation = null
                    val params = Arguments.createMap()
                    params.putBoolean("active", false)
                    sendEvent("onHotspotStopped", params)
                }

                override fun onFailed(reason: Int) {
                    Log.e(TAG, "LocalOnlyHotspot failed with reason: $reason")
                    val errorMsg = when (reason) {
                        ERROR_NO_CHANNEL -> "No channel available"
                        ERROR_GENERIC -> "Generic error"
                        ERROR_INCOMPATIBLE_MODE -> "Incompatible mode — is Wi-Fi tethering already on?"
                        ERROR_TETHERING_DISALLOWED -> "Tethering disallowed by system"
                        else -> "Unknown error (code: $reason)"
                    }
                    promise.reject("HOTSPOT_FAILED", errorMsg)
                }
            }, mainHandler)
        } catch (e: SecurityException) {
            Log.e(TAG, "SecurityException — missing location permission?", e)
            promise.reject("HOTSPOT_PERMISSION_ERROR",
                "Location permission is required. Please enable Location Services and grant location permission.")
        } catch (e: Exception) {
            Log.e(TAG, "Exception starting hotspot", e)
            promise.reject("HOTSPOT_ERROR", e.message)
        }
    }

    @ReactMethod
    fun stopHotspot(promise: Promise) {
        try {
            hotspotReservation?.close()
            hotspotReservation = null
            Log.d(TAG, "Hotspot reservation closed")
            promise.resolve(true)
        } catch (e: Exception) {
            Log.e(TAG, "Error stopping hotspot", e)
            promise.reject("HOTSPOT_STOP_ERROR", e.message)
        }
    }

    @ReactMethod
    fun isHotspotRunning(promise: Promise) {
        promise.resolve(hotspotReservation != null)
    }

    @ReactMethod
    fun isLocationEnabled(promise: Promise) {
        try {
            val locationManager = ctx.applicationContext.getSystemService(
                android.content.Context.LOCATION_SERVICE
            ) as LocationManager

            val gpsEnabled = locationManager.isProviderEnabled(LocationManager.GPS_PROVIDER)
            val networkEnabled = locationManager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)

            Log.d(TAG, "Location check — GPS: $gpsEnabled, Network: $networkEnabled")
            promise.resolve(gpsEnabled || networkEnabled)
        } catch (e: Exception) {
            Log.e(TAG, "Error checking location services", e)
            promise.resolve(false)
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
