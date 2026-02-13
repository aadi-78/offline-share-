
import React, { useState, useRef, useCallback, useEffect } from 'react';
import {
    StyleSheet, Text, View, TouchableOpacity, ScrollView,
    Alert, ActivityIndicator, Dimensions, NativeModules, Platform, PermissionsAndroid, Linking
} from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { File, Paths } from 'expo-file-system';
import { StorageAccessFramework } from 'expo-file-system/legacy';
import * as FileSystemLegacy from 'expo-file-system/legacy';
import { COLORS, STYLES } from '../constants/theme';

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const { WifiConnector, MediaScanner, HotspotManager, SafTransfer } = NativeModules;
const DOWNLOAD_TEMP_DIR = `${FileSystemLegacy.cacheDirectory}offshare-downloads/`;

// ═══════════════════════════════════════════════════════════════════════════════
// SAF DIRECTORY PERSISTENCE
// ═══════════════════════════════════════════════════════════════════════════════
// Store the SAF directory URI in app cache so user doesn't re-pick every time.
const SAF_URI_CACHE_FILE = new File(Paths.cache, 'saf_download_uri.txt');

const loadSavedSafUri = () => {
    try {
        if (SAF_URI_CACHE_FILE.exists) {
            const raw = SAF_URI_CACHE_FILE.text();
            const uri = typeof raw === 'string' ? raw.trim() : String(raw || '').trim();
            if (uri && uri.startsWith('content://')) {
                console.log('[SAF] Loaded persisted URI:', uri);
                return uri;
            }
        }
    } catch (e) {
        console.warn('[SAF] Failed to load persisted URI:', e);
    }
    return null;
};

const saveSafUri = (uri) => {
    try {
        SAF_URI_CACHE_FILE.write(uri);
        console.log('[SAF] Persisted URI:', uri);
    } catch (e) {
        console.warn('[SAF] Failed to persist URI:', e);
    }
};

/**
 * Get MIME type from filename extension.
 */
const getMimeType = (fileName) => {
    const ext = (fileName.split('.').pop() || '').toLowerCase();
    const mimeMap = {
        jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
        gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
        svg: 'image/svg+xml',
        mp4: 'video/mp4', mkv: 'video/x-matroska', avi: 'video/x-msvideo',
        mov: 'video/quicktime', webm: 'video/webm',
        mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg',
        flac: 'audio/flac', aac: 'audio/aac',
        pdf: 'application/pdf', zip: 'application/zip',
        doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        txt: 'text/plain', json: 'application/json', xml: 'text/xml',
        apk: 'application/vnd.android.package-archive',
    };
    return mimeMap[ext] || 'application/octet-stream';
};

// ═══════════════════════════════════════════════════════════════════════════════
// STATE MACHINE
// ═══════════════════════════════════════════════════════════════════════════════
// Allowed transitions ONLY:
// IDLE → SCANNING → SCANNED → CONNECTING → CONNECTED → RECEIVING → COMPLETE
// Any failure → ERROR → (retry → CONNECTING | reset → IDLE)
// ═══════════════════════════════════════════════════════════════════════════════
const STATES = {
    IDLE: 'idle',
    SCANNING: 'scanning',
    SCANNED: 'scanned',
    CONNECTING: 'connecting',
    CONNECTED: 'connected',
    RECEIVING: 'receiving',
    COMPLETE: 'complete',
    ERROR: 'error',
};

// Valid state transitions map
const VALID_TRANSITIONS = {
    [STATES.IDLE]: [STATES.SCANNING],
    [STATES.SCANNING]: [STATES.SCANNED, STATES.IDLE],
    [STATES.SCANNED]: [STATES.CONNECTING, STATES.IDLE],
    [STATES.CONNECTING]: [STATES.CONNECTED, STATES.ERROR],
    [STATES.CONNECTED]: [STATES.RECEIVING, STATES.ERROR, STATES.IDLE],
    [STATES.RECEIVING]: [STATES.COMPLETE, STATES.ERROR],
    [STATES.COMPLETE]: [STATES.IDLE],
    [STATES.ERROR]: [STATES.CONNECTING, STATES.IDLE],
};

// ═══════════════════════════════════════════════════════════════════════════════
// NETWORK UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * fetch wrapper with hard timeout — never hangs forever.
 */
const fetchWithTimeout = (url, options = {}, timeout = 8000) => {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);

    return fetch(url, {
        ...options,
        signal: controller.signal,
    }).then((response) => {
        clearTimeout(id);
        return response;
    }).catch((error) => {
        clearTimeout(id);
        if (error.name === 'AbortError') {
            throw new Error(`Request timed out after ${timeout}ms`);
        }
        throw error;
    });
};

/**
 * Validate that an IP is a private LAN address.
 * Accepted ranges: 192.168.x.x, 10.x.x.x, 172.16-31.x.x
 */
const isValidLanAddress = (ip) => {
    if (!ip || typeof ip !== 'string') return false;
    if (ip.startsWith('192.168.')) return true;
    if (ip.startsWith('10.')) return true;
    // 172.16.0.0 – 172.31.255.255
    const parts = ip.split('.');
    if (parts[0] === '172') {
        const second = parseInt(parts[1], 10);
        if (second >= 16 && second <= 31) return true;
    }
    return false;
};

/**
 * Validate QR payload has all required fields.
 */
const validateQRPayload = (parsed) => {
    if (!parsed || typeof parsed !== 'object') {
        throw new Error('Invalid QR data format');
    }
    if (!parsed.ip) throw new Error('Missing sender IP in QR data');
    if (!parsed.port) throw new Error('Missing sender port in QR data');
    if (!parsed.filesEndpoint) throw new Error('Missing files endpoint in QR data');
    if (!isValidLanAddress(parsed.ip)) {
        throw new Error(`Invalid LAN address: ${parsed.ip}. Expected private network IP.`);
    }
    return true;
};

const sanitizeFileName = (name) => {
    if (!name || typeof name !== 'string') return `file_${Date.now()}`;
    const sanitized = name.replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_').trim();
    if (!sanitized) return `file_${Date.now()}`;
    return sanitized.length > 120 ? sanitized.slice(0, 120) : sanitized;
};

const getSafBaseName = (fileName) => {
    const idx = fileName.lastIndexOf('.');
    const base = idx > 0 ? fileName.slice(0, idx) : fileName;
    const normalized = sanitizeFileName(base).replace(/\./g, '_');
    return normalized.length > 80 ? normalized.slice(0, 80) : normalized;
};

/**
 * Robust QR payload parser.
 * Handles object JSON, double-stringified JSON, and escaped JSON strings.
 */
const parseQRPayloadRobust = (raw) => {
    let current = raw;

    for (let i = 0; i < 5; i++) {
        if (current && typeof current === 'object') return current;
        if (typeof current !== 'string') break;

        const trimmed = current.trim();
        if (!trimmed) break;

        const attempts = [
            trimmed,
            // Strip wrapping quotes if scanner returned a quoted JSON blob
            (trimmed.startsWith('"') && trimmed.endsWith('"')) ? trimmed.slice(1, -1) : trimmed,
            // Unescape common payload escapes from nested stringification
            trimmed.replace(/\\"/g, '"').replace(/\\\\/g, '\\'),
        ];

        let next = null;
        for (const candidate of attempts) {
            try {
                next = JSON.parse(candidate);
                break;
            } catch (_) {
                // Try next candidate form
            }
        }

        if (next === null) break;
        current = next;
    }

    throw new Error('Could not parse QR payload. Unsupported encoding.');
};

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

const ReceiveScreen = ({ onBack }) => {
    const [status, setStatus] = useState(STATES.IDLE);
    const [sender, setSender] = useState(null);
    const [files, setFiles] = useState([]);
    const [scannerOpen, setScannerOpen] = useState(false);
    const [fileProgress, setFileProgress] = useState({});
    const [overallProgress, setOverallProgress] = useState(0);
    const [downloadedFiles, setDownloadedFiles] = useState([]);
    const [errorMsg, setErrorMsg] = useState('');
    const [errorType, setErrorType] = useState(''); // 'wifi' | 'ping' | 'download' | 'general'
    const [totalSize, setTotalSize] = useState(0);
    const [downloadedSize, setDownloadedSize] = useState(0);
    const [connectingStep, setConnectingStep] = useState(''); // Sub-status for connecting phase

    const [permission, requestPermission] = useCameraPermissions();
    const hasScanned = useRef(false);
    const isReceiving = useRef(false);
    const safFolderUri = useRef(loadSavedSafUri());

    // ─── State Machine Enforcer ───────────────────────────────────────
    const transitionTo = useCallback((newState) => {
        setStatus(prev => {
            const allowed = VALID_TRANSITIONS[prev] || [];
            if (allowed.includes(newState)) {
                console.log(`[StateMachine] ${prev} → ${newState}`);
                return newState;
            }
            console.warn(`[StateMachine] BLOCKED: ${prev} → ${newState} (allowed: ${allowed.join(', ')})`);
            return prev;
        });
    }, []);

    // ─── Cleanup on unmount ───────────────────────────────────────────
    useEffect(() => {
        return () => {
            // Clear network binding when leaving the screen
            if (WifiConnector) {
                WifiConnector.clearNetworkBinding().catch(() => { });
            }
        };
    }, []);

    // ─── Request location + nearby Wi-Fi permissions (needed for Wi-Fi connect) ──
    const ensureLocationPermission = async () => {
        if (Platform.OS !== 'android') return true;

        try {
            const version = Platform.Version;
            const finePerm = PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION;
            const coarsePerm = PermissionsAndroid.PERMISSIONS.ACCESS_COARSE_LOCATION;
            const nearbyPerm = PermissionsAndroid.PERMISSIONS.NEARBY_WIFI_DEVICES;
            const perms = [
                finePerm,
                coarsePerm,
            ];

            // Android 13+ (API 33) requires NEARBY_WIFI_DEVICES for Wi-Fi operations
            if (version >= 33 && nearbyPerm) {
                perms.push(nearbyPerm);
            }

            // Check if all permissions are already granted
            const checks = await Promise.all(
                perms.map(p => PermissionsAndroid.check(p))
            );
            const allGranted = checks.every(Boolean);
            if (allGranted) {
                console.log('[ReceiveScreen] All permissions already granted');
                return true;
            }

            // Request missing permissions
            console.log('[ReceiveScreen] Requesting permissions:', perms);
            const result = await PermissionsAndroid.requestMultiple(perms);
            console.log('[ReceiveScreen] Permission result:', result);

            // Re-check final state (more reliable than relying only on requestMultiple map)
            const finalChecks = await Promise.all(perms.map(p => PermissionsAndroid.check(p)));
            const grantedMap = Object.fromEntries(perms.map((p, i) => [p, finalChecks[i]]));

            const locationGranted = Boolean(grantedMap[finePerm] && grantedMap[coarsePerm]);

            let nearbyGranted = true;
            if (version >= 33 && nearbyPerm) {
                nearbyGranted = Boolean(grantedMap[nearbyPerm]);
            }

            if (locationGranted && nearbyGranted) return true;

            Alert.alert(
                'Permissions Required',
                'OffShare needs Location (Precise), Nearby Devices, and Location Services ON to connect to the sender\'s Wi-Fi.\n\nPlease enable them in Settings.',
                [
                    { text: 'Open Settings', onPress: () => Linking.openSettings() },
                    { text: 'Cancel', style: 'cancel' }
                ]
            );
            return false;
        } catch (e) {
            console.error('[ReceiveScreen] Permission error:', e);
            return false;
        }
    };

    // ─── Ensure Android Location Services are ON (required by WifiNetworkSpecifier) ──
    const ensureLocationServices = async () => {
        if (Platform.OS !== 'android') return true;

        try {
            if (!HotspotManager?.isLocationEnabled) return true;

            const enabled = await HotspotManager.isLocationEnabled();
            if (enabled) return true;

            return new Promise((resolve) => {
                Alert.alert(
                    'Enable Location Services',
                    'Location Services must be turned ON to connect to the sender hotspot.\n\nPlease enable Location and try again.',
                    [
                        {
                            text: 'Open Location Settings',
                            onPress: () => {
                                Linking.sendIntent('android.settings.LOCATION_SOURCE_SETTINGS').catch(() => {
                                    Linking.openSettings();
                                });
                                resolve(false);
                            },
                        },
                        {
                            text: 'Cancel',
                            style: 'cancel',
                            onPress: () => resolve(false),
                        },
                    ],
                    { cancelable: false }
                );
            });
        } catch (e) {
            console.warn('[ReceiveScreen] Location services check failed:', e);
            return false;
        }
    };

    // ═══════════════════════════════════════════════════════════════════
    // STEP 1: Open QR Scanner
    // ═══════════════════════════════════════════════════════════════════
    const openScanner = async () => {
        if (!permission?.granted) {
            const result = await requestPermission();
            if (!result.granted) {
                Alert.alert('Camera Permission', 'Camera access is required to scan QR codes.');
                return;
            }
        }
        hasScanned.current = false;
        setScannerOpen(true);
        transitionTo(STATES.SCANNING);
    };

    // ═══════════════════════════════════════════════════════════════════
    // STEP 2: Handle QR Scan — Validate + Extract sender info
    // ═══════════════════════════════════════════════════════════════════
    const handleBarCodeScanned = ({ data }) => {
        if (hasScanned.current) return;
        hasScanned.current = true;
        setScannerOpen(false);

        console.log("RAW QR DATA:", data);
        console.log("RAW QR LENGTH:", data.length);
        console.log("RAW QR CHAR CODES:", data.split('').map(c => c.charCodeAt(0)));


        try {
            console.log("TRYING TO PARSE QR DATA...");
            const parsed = parseQRPayloadRobust(data);
            console.log("PARSED QR DATA:", parsed);
            console.log("PARSED QR TYPE:", typeof parsed);

            // SECURITY: Never trust QR blindly — validate all fields
            validateQRPayload(parsed);

            const senderInfo = {
                ip: parsed.ip,
                port: parsed.port,
                ssid: parsed.ssid || '',
                password: parsed.password || '',
                deviceName: parsed.deviceName || 'OffShare Sender',
                filesEndpoint: parsed.filesEndpoint,
                downloadEndpoint: parsed.downloadEndpoint || '/download',
            };
            setSender(senderInfo);
            transitionTo(STATES.SCANNED);

            // Auto-start connection flow
            beginConnection(senderInfo);

        } catch (e) {
            console.error('[ReceiveScreen] QR validation failed:', e);
            Alert.alert(
                'Invalid QR Code',
                e.message || 'Could not parse QR code data. Make sure you are scanning an OffShare QR code.'
            );
            transitionTo(STATES.IDLE);
        }
    };

    // ═══════════════════════════════════════════════════════════════════
    // STEP 3: Connect — Wi-Fi join → Bind network → Ping → Fetch files
    // ═══════════════════════════════════════════════════════════════════
    const beginConnection = async (senderInfo) => {
        const info = senderInfo || sender;
        if (!info) return;

        transitionTo(STATES.CONNECTING);
        setConnectingStep('Preparing...');

        try {
            // ── 3a: Ensure location permission ──
            setConnectingStep('Checking permissions...');
            const hasLocation = await ensureLocationPermission();
            if (!hasLocation) {
                throw {
                    type: 'general',
                    message: 'Location permission is required to connect to the sender\'s Wi-Fi network. Please grant location access and try again.'
                };
            }

            // ── 3b: Ensure location services before hotspot join ──
            if (info.ssid) {
                setConnectingStep('Checking location services...');
                const locationServicesOn = await ensureLocationServices();
                if (!locationServicesOn) {
                    throw {
                        type: 'wifi',
                        message: 'Location Services are OFF.\n\nEnable Location Services on this device, then retry connection.'
                    };
                }
            }

            // ── 3c: Auto-connect to sender's hotspot ──
            if (info.ssid && WifiConnector) {
                const preJoinBaseUrl = `http://${info.ip}:${info.port}`;
                let preJoinReachable = false;

                // Fast-path: if sender is already reachable, skip hotspot join.
                setConnectingStep('Checking if sender is already reachable...');
                try {
                    const preJoinPing = await fetchWithTimeout(
                        `${preJoinBaseUrl}/ping`,
                        { method: 'GET', headers: { 'Accept': 'application/json' } },
                        2500
                    );
                    if (preJoinPing.ok) {
                        const preJoinData = await preJoinPing.json();
                        if (preJoinData?.status === 'ok') {
                            preJoinReachable = true;
                            console.log('[ReceiveScreen] Sender reachable before Wi-Fi join, skipping hotspot connect');
                            setConnectingStep('Sender already reachable');
                        }
                    }
                } catch (_) {
                    // Not reachable yet, continue to hotspot join.
                }

                if (!preJoinReachable) {
                    setConnectingStep(`Joining "${info.ssid}"...`);
                    console.log(`[ReceiveScreen] Connecting to hotspot: ${info.ssid}`);

                    try {
                        const result = await WifiConnector.connectToHotspot(info.ssid, info.password);
                        console.log(`[ReceiveScreen] Hotspot connection result: ${result}`);
                        setConnectingStep('Wi-Fi connected! Verifying...');

                        // Small delay to let network stabilize after binding
                        await new Promise(resolve => setTimeout(resolve, 1500));
                    } catch (wifiError) {
                        console.error('[ReceiveScreen] Wi-Fi connect failed:', wifiError);

                        // Fallback: if join fails, assume we may already be on sender network.
                        // Try direct ping using QR IP before failing hard.
                        setConnectingStep('Wi-Fi join failed, trying direct sender ping...');
                        const fallbackBaseUrl = `http://${info.ip}:${info.port}`;
                        try {
                            const fallbackPing = await fetchWithTimeout(
                                `${fallbackBaseUrl}/ping`,
                                { method: 'GET', headers: { 'Accept': 'application/json' } },
                                5000
                            );

                            if (!fallbackPing.ok) {
                                throw new Error(`Ping returned status ${fallbackPing.status}`);
                            }

                            const fallbackPingData = await fallbackPing.json();
                            if (fallbackPingData?.status !== 'ok') {
                                throw new Error('Unexpected ping response');
                            }

                            console.log('[ReceiveScreen] Fallback ping succeeded — proceeding without Wi-Fi join');
                            setConnectingStep('Sender reachable without hotspot join');
                        } catch (fallbackErr) {
                            const wifiCode = wifiError?.code ? ` (${wifiError.code})` : '';
                            throw {
                                type: 'wifi',
                                message:
                                    `Could not join sender network "${info.ssid}"${wifiCode}.\n\n` +
                                    `${wifiError?.message || 'Wi-Fi join failed.'}\n\n` +
                                    `Fallback direct ping to ${info.ip}:${info.port} also failed.\n` +
                                    `${fallbackErr?.message || 'Sender not reachable on current network.'}`
                            };
                        }
                    }
                }
            } else {
                console.log('[ReceiveScreen] No SSID in QR data — assuming already on correct network');
            }

            // ── 3d: Validate LAN address ──
            if (!isValidLanAddress(info.ip)) {
                throw {
                    type: 'general',
                    message: `Invalid LAN address: ${info.ip}.\nExpected a private network IP (192.168.x.x or 10.x.x.x).`
                };
            }

            // ── 3e: Ping sender with timeout ──
            const baseUrl = `http://${info.ip}:${info.port}`;
            setConnectingStep(`Pinging ${info.ip}...`);
            console.log(`[ReceiveScreen] Pinging ${baseUrl}/ping`);

            let pingResponse;
            try {
                pingResponse = await fetchWithTimeout(`${baseUrl}/ping`, {
                    method: 'GET',
                    headers: { 'Accept': 'application/json' },
                }, 8000);
            } catch (pingErr) {
                throw {
                    type: 'ping',
                    message: `Not connected to sender's Wi-Fi.\n\nCould not reach ${info.ip}:${info.port}.\n${pingErr.message}`
                };
            }

            if (!pingResponse.ok) {
                throw {
                    type: 'ping',
                    message: `Ping returned status ${pingResponse.status}. Server may not be ready.`
                };
            }

            const pingData = await pingResponse.json();
            if (pingData.status !== 'ok') {
                throw {
                    type: 'ping',
                    message: 'Unexpected ping response from sender. Make sure the sender app is ready.'
                };
            }

            console.log('[ReceiveScreen] Ping OK ✓');
            setConnectingStep('Fetching file list...');

            // ── 3f: Fetch file list ──
            const filesResponse = await fetchWithTimeout(
                `${baseUrl}${info.filesEndpoint}`,
                { method: 'GET', headers: { 'Accept': 'application/json' } },
                10000
            );

            if (!filesResponse.ok) {
                throw {
                    type: 'general',
                    message: `Server responded with ${filesResponse.status} when fetching file list.`
                };
            }

            const fileList = await filesResponse.json();
            setFiles(fileList);

            const total = fileList.reduce((sum, f) => sum + (f.size || 0), 0);
            setTotalSize(total);

            console.log(`[ReceiveScreen] Got ${fileList.length} files, total: ${total} bytes`);
            transitionTo(STATES.CONNECTED);

        } catch (err) {
            console.error('[ReceiveScreen] Connection flow failed:', err);
            const errType = err.type || 'general';
            const errMessage = err.message || 'An unexpected error occurred.';
            setErrorType(errType);
            setErrorMsg(errMessage);
            transitionTo(STATES.ERROR);

            // Clear binding on error
            if (WifiConnector) {
                WifiConnector.clearNetworkBinding().catch(() => { });
            }
        }
    };

    // ═══════════════════════════════════════════════════════════════════
    // STEP 4: Download via SAF to Public Downloads/OffShare
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Ensure we have a SAF directory URI for saving files.
     * - If we have a persisted URI, use it.
     * - Otherwise prompt the user to pick the folder (pre-navigated to Download/OffShare).
     * - The user picks the folder and we save files directly there — no subfolder creation.
     */
    const ensureSafDirectory = async () => {
        // 1) Try persisted URI
        if (safFolderUri.current) {
            console.log('[SAF] Using persisted folder URI:', safFolderUri.current);
            return safFolderUri.current;
        }

        // 2) Ask user to pick the directory — pre-navigate to Download
        console.log('[SAF] Requesting directory permissions...');
        const initialUri = StorageAccessFramework.getUriForDirectoryInRoot('Download');

        const permissions = await StorageAccessFramework.requestDirectoryPermissionsAsync(initialUri);

        if (!permissions.granted) {
            throw new Error('Storage access denied. Please grant access to save received files.');
        }

        const selectedUri = permissions.directoryUri;
        console.log('[SAF] User selected directory:', selectedUri);

        // 3) Persist for future sessions — use the selected directory directly
        safFolderUri.current = selectedUri;
        saveSafUri(selectedUri);

        return selectedUri;
    };

    const startReceiving = async () => {
        if (!sender || files.length === 0) return;

        // ── Pre-flight checks before receiving ──
        const hasLocationPermission = await ensureLocationPermission();
        if (!hasLocationPermission) {
            setErrorType('general');
            setErrorMsg(
                'Location permission is required before receiving files.\n\nPlease grant permission and try again.'
            );
            transitionTo(STATES.ERROR);
            return;
        }

        const locationServicesOn = await ensureLocationServices();
        if (!locationServicesOn) {
            setErrorType('general');
            setErrorMsg(
                'Location Services are OFF.\n\nPlease enable Location Services and try again.'
            );
            transitionTo(STATES.ERROR);
            return;
        }

        isReceiving.current = true;
        transitionTo(STATES.RECEIVING);
        setOverallProgress(0);
        setDownloadedSize(0);

        const baseUrl = `http://${sender.ip}:${sender.port}`;

        // ── Get SAF directory ──
        let targetDirUri;
        try {
            targetDirUri = await ensureSafDirectory();
            console.log(`[ReceiveScreen] SAF target directory: ${targetDirUri}`);
        } catch (dirErr) {
            console.error('[ReceiveScreen] SAF directory setup failed:', dirErr);
            setErrorType('download');
            setErrorMsg(`Could not access download folder.\n${dirErr.message}`);
            transitionTo(STATES.ERROR);
            return;
        }

        const completed = [];
        let totalBytesDownloaded = 0;

        if (!FileSystemLegacy.cacheDirectory) {
            setErrorType('download');
            setErrorMsg('Cache directory unavailable on this device.');
            transitionTo(STATES.ERROR);
            return;
        }

        try {
            await FileSystemLegacy.makeDirectoryAsync(DOWNLOAD_TEMP_DIR, { intermediates: true });
        } catch (e) {
            // Directory may already exist; proceed.
        }

        for (let i = 0; i < files.length; i++) {
            if (!isReceiving.current) break;

            const file = files[i];
            const downloadUrl = `${baseUrl}${sender.downloadEndpoint}?name=${encodeURIComponent(file.name)}`;
            const safeFileName = sanitizeFileName(file.name);
            const tempFileUri = `${DOWNLOAD_TEMP_DIR}${Date.now()}_${i}_${safeFileName}`;
            let downloadedFileUri = null;

            try {
                setFileProgress(prev => ({
                    ...prev,
                    [file.name]: { status: 'downloading', progress: 0 }
                }));

                console.log(`[ReceiveScreen] Downloading (${i + 1}/${files.length}): ${file.name}`);
                console.log(`[ReceiveScreen] URL: ${downloadUrl}`);

                // ── Step A: Download file to temp storage (native) ──
                setFileProgress(prev => ({
                    ...prev,
                    [file.name]: { status: 'downloading', progress: 15 }
                }));

                // Download directly to disk (native) to avoid JS blob/base64 memory pressure.
                const dl = await FileSystemLegacy.downloadAsync(downloadUrl, tempFileUri);
                downloadedFileUri = dl.uri;

                setFileProgress(prev => ({
                    ...prev,
                    [file.name]: { status: 'downloading', progress: 55 }
                }));

                const info = await FileSystemLegacy.getInfoAsync(downloadedFileUri);
                const fileSize = (info && info.exists && !info.isDirectory && typeof info.size === 'number')
                    ? info.size
                    : (file.size || 0);

                console.log(`[ReceiveScreen] Downloaded to temp file: ${downloadedFileUri} (${fileSize} bytes)`);

                setFileProgress(prev => ({
                    ...prev,
                    [file.name]: { status: 'downloading', progress: 70 }
                }));

                // ── Step B: Create destination file via SAF ──
                const mimeType = getMimeType(file.name);
                // Strip extension from name since SAF auto-appends based on MIME
                const nameWithoutExt = getSafBaseName(file.name);

                const fileUri = await StorageAccessFramework.createFileAsync(
                    targetDirUri,
                    nameWithoutExt,
                    mimeType
                );

                console.log(`[ReceiveScreen] SAF file created: ${fileUri}`);

                setFileProgress(prev => ({
                    ...prev,
                    [file.name]: { status: 'downloading', progress: 82 }
                }));

                // ── Step C: Native stream copy to SAF file (no JS base64/OOM) ──
                if (!SafTransfer?.copyFileToContentUri) {
                    throw new Error('SafTransfer native module unavailable. Rebuild the app and try again.');
                }
                await SafTransfer.copyFileToContentUri(downloadedFileUri, fileUri);
                console.log(`[ReceiveScreen] SAF native copy succeeded: ${file.name}`);

                setFileProgress(prev => ({
                    ...prev,
                    [file.name]: { status: 'downloading', progress: 92 }
                }));

                totalBytesDownloaded += fileSize;

                completed.push({
                    ...file,
                    localUri: fileUri,
                    savedSize: fileSize,
                });

                setFileProgress(prev => ({
                    ...prev,
                    [file.name]: { status: 'completed', progress: 100 }
                }));

                setDownloadedFiles([...completed]);
                setOverallProgress(Math.min((totalBytesDownloaded / totalSize) * 100, 99));
                setDownloadedSize(totalBytesDownloaded);

                console.log(`[ReceiveScreen] ✓ Saved via SAF: ${file.name} (${fileSize} bytes)`);

                // ── Trigger media scan ──
                if (MediaScanner) {
                    try {
                        await MediaScanner.scanFile(fileUri);
                        console.log(`[ReceiveScreen] Media scan triggered: ${file.name}`);
                    } catch (scanErr) {
                        console.warn(`[ReceiveScreen] Media scan failed for ${file.name}:`, scanErr);
                    }
                }

            } catch (e) {
                console.error(`[ReceiveScreen] Download failed for ${file.name}:`, e);
                setFileProgress(prev => ({
                    ...prev,
                    [file.name]: { status: 'error', progress: 0, error: e.message }
                }));
                // Continue with remaining files
            } finally {
                if (downloadedFileUri) {
                    try {
                        await FileSystemLegacy.deleteAsync(downloadedFileUri, { idempotent: true });
                    } catch (_) {
                        // Ignore temp cleanup errors
                    }
                }
            }
        }

        isReceiving.current = false;

        // ── Clear network binding after transfer ──
        if (WifiConnector) {
            try {
                await WifiConnector.clearNetworkBinding();
                console.log('[ReceiveScreen] Network binding cleared after transfer');
            } catch (e) {
                console.warn('[ReceiveScreen] Failed to clear network binding:', e);
            }
        }

        transitionTo(STATES.COMPLETE);
        setOverallProgress(100);

        const failedCount = files.length - completed.length;
        const savePath = 'Download/OffShare/';
        if (failedCount > 0) {
            Alert.alert(
                'Transfer Partially Complete',
                `${completed.length} of ${files.length} files received.\n${failedCount} file(s) failed.\n\nSaved to: ${savePath}`
            );
        } else {
            Alert.alert(
                'Transfer Complete',
                `All ${completed.length} files received successfully!\n\nSaved to: ${savePath}`
            );
        }
    };

    // ═══════════════════════════════════════════════════════════════════
    // ERROR RECOVERY
    // ═══════════════════════════════════════════════════════════════════
    const retryConnection = () => {
        setErrorMsg('');
        setErrorType('');
        if (sender) {
            beginConnection(sender);
        } else {
            resetTransfer();
        }
    };

    const resetTransfer = async () => {
        isReceiving.current = false;

        // Clear network binding
        if (WifiConnector) {
            try { await WifiConnector.clearNetworkBinding(); } catch (e) { }
        }

        setStatus(STATES.IDLE);
        setSender(null);
        setFiles([]);
        setFileProgress({});
        setOverallProgress(0);
        setDownloadedFiles([]);
        setDownloadedSize(0);
        setTotalSize(0);
        setErrorMsg('');
        setErrorType('');
        setConnectingStep('');
        hasScanned.current = false;
    };

    // ═══════════════════════════════════════════════════════════════════
    // UTILITIES
    // ═══════════════════════════════════════════════════════════════════
    const formatSize = (bytes) => {
        if (!bytes || bytes === 0) return '0 B';
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
        return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
    };

    const getStepState = (stepName) => {
        const order = [
            STATES.IDLE, STATES.SCANNING, STATES.SCANNED,
            STATES.CONNECTING, STATES.CONNECTED, STATES.RECEIVING, STATES.COMPLETE
        ];
        const currentIdx = order.indexOf(status);
        const stepMap = { scan: 1, connect: 4, receive: 5 };
        const stepIdx = stepMap[stepName] || 0;
        if (currentIdx >= stepIdx + 1) return 2; // completed
        if (currentIdx >= stepIdx) return 1; // active
        return 0; // inactive
    };

    const getErrorIcon = () => {
        switch (errorType) {
            case 'wifi': return 'wifi-off';
            case 'ping': return 'server-network-off';
            case 'download': return 'download-off';
            default: return 'alert-circle-outline';
        }
    };

    const getErrorTitle = () => {
        switch (errorType) {
            case 'wifi': return 'Wi-Fi Connection Failed';
            case 'ping': return 'Cannot Reach Sender';
            case 'download': return 'Download Failed';
            default: return 'Connection Failed';
        }
    };

    // ═══════════════════════════════════════════════════════════════════
    // RENDER: Full-screen QR Scanner
    // ═══════════════════════════════════════════════════════════════════
    if (scannerOpen) {
        return (
            <View style={styles.scannerContainer}>
                <CameraView
                    style={StyleSheet.absoluteFillObject}
                    facing="back"
                    barcodeScannerSettings={{
                        barcodeTypes: ['qr'],
                    }}
                    onBarcodeScanned={handleBarCodeScanned}
                />
                <View style={styles.scannerOverlay}>
                    <View style={styles.scannerHeader}>
                        <TouchableOpacity
                            onPress={() => { setScannerOpen(false); setStatus(STATES.IDLE); }}
                            style={styles.scannerCloseBtn}
                        >
                            <MaterialCommunityIcons name="close" size={28} color="#FFF" />
                        </TouchableOpacity>
                        <Text style={styles.scannerTitle}>Scan OffShare QR Code</Text>
                        <View style={{ width: 40 }} />
                    </View>

                    <View style={styles.scannerFrame}>
                        <View style={[styles.corner, styles.topLeft]} />
                        <View style={[styles.corner, styles.topRight]} />
                        <View style={[styles.corner, styles.bottomLeft]} />
                        <View style={[styles.corner, styles.bottomRight]} />
                    </View>

                    <Text style={styles.scannerHint}>
                        Point your camera at the QR code on the sender's screen
                    </Text>
                </View>
            </View>
        );
    }

    // ═══════════════════════════════════════════════════════════════════
    // RENDER: Main UI
    // ═══════════════════════════════════════════════════════════════════
    return (
        <ScrollView style={styles.container} contentContainerStyle={styles.contentContainer}>
            {/* Header */}
            <View style={styles.header}>
                <TouchableOpacity onPress={onBack}>
                    <MaterialCommunityIcons name="arrow-left" size={24} color={COLORS.text} />
                </TouchableOpacity>
                <Text style={styles.headerTitle}>Receive Files</Text>
                <View style={{ width: 24 }} />
            </View>

            {/* Step Indicator */}
            <View style={styles.stepContainer}>
                <StepIndicator step={getStepState('scan')} label="Scan" />
                <View style={styles.stepLine} />
                <StepIndicator step={getStepState('connect')} label="Connect" />
                <View style={styles.stepLine} />
                <StepIndicator step={getStepState('receive')} label="Receive" />
            </View>

            {/* ─── Section: IDLE — Scan QR ─── */}
            {status === STATES.IDLE && (
                <View style={styles.centerContent}>
                    <TouchableOpacity style={styles.scanButton} onPress={openScanner}>
                        <MaterialCommunityIcons name="qrcode-scan" size={48} color={COLORS.accent} />
                        <Text style={styles.scanButtonText}>Scan QR Code</Text>
                        <Text style={styles.scanSubtext}>
                            Scan the code shown on sender's screen
                        </Text>
                    </TouchableOpacity>

                    <View style={styles.featureBadges}>
                        <View style={styles.badge}>
                            <MaterialCommunityIcons name="wifi" size={14} color={COLORS.success} />
                            <Text style={styles.badgeText}>Auto Wi-Fi Connect</Text>
                        </View>
                        <View style={styles.badge}>
                            <MaterialCommunityIcons name="shield-check" size={14} color={COLORS.success} />
                            <Text style={styles.badgeText}>Secure LAN Transfer</Text>
                        </View>
                    </View>
                </View>
            )}

            {/* ─── Section: SCANNED — Brief transition, auto-moves to CONNECTING ─── */}
            {status === STATES.SCANNED && sender && (
                <View style={[STYLES.card, styles.centerContent]}>
                    <MaterialCommunityIcons name="qrcode-scan" size={40} color={COLORS.success} />
                    <Text style={[STYLES.heading, { marginTop: 12 }]}>QR Scanned!</Text>
                    <ActivityIndicator size="small" color={COLORS.accent} style={{ marginTop: 10 }} />
                    <Text style={[STYLES.subtitle, { textAlign: 'center', marginTop: 8 }]}>
                        Preparing to connect...
                    </Text>
                </View>
            )}

            {/* ─── Section: CONNECTING — Auto Wi-Fi + Ping + Fetch ─── */}
            {status === STATES.CONNECTING && (
                <View style={[STYLES.card, styles.centerContent]}>
                    <ActivityIndicator size="large" color={COLORS.accent} />
                    <Text style={[STYLES.heading, { marginTop: 16 }]}>Connecting...</Text>
                    <Text style={[STYLES.subtitle, { textAlign: 'center', marginTop: 8 }]}>
                        {connectingStep || 'Establishing connection...'}
                    </Text>

                    {sender && (
                        <View style={styles.connectionInfoCard}>
                            {sender.ssid ? (
                                <View style={styles.infoRow}>
                                    <Text style={styles.infoLabel}>Network:</Text>
                                    <Text style={styles.infoValue}>{sender.ssid}</Text>
                                </View>
                            ) : null}
                            <View style={styles.infoRow}>
                                <Text style={styles.infoLabel}>Server:</Text>
                                <Text style={styles.infoValue}>{sender.ip}:{sender.port}</Text>
                            </View>
                        </View>
                    )}
                </View>
            )}

            {/* ─── Section: ERROR ─── */}
            {status === STATES.ERROR && (
                <View style={[STYLES.card, styles.centerContent]}>
                    <MaterialCommunityIcons name={getErrorIcon()} size={60} color={COLORS.error} />
                    <Text style={[STYLES.heading, { marginTop: 16, color: COLORS.error }]}>
                        {getErrorTitle()}
                    </Text>
                    <Text style={[STYLES.subtitle, { textAlign: 'center', marginTop: 8 }]}>
                        {errorMsg || "Make sure you're connected to the sender's Wi-Fi network."}
                    </Text>

                    {errorType === 'wifi' && (
                        <View style={styles.errorHintCard}>
                            <MaterialCommunityIcons name="information-outline" size={16} color={COLORS.accent} />
                            <Text style={styles.errorHintText}>
                                Ensure the sender's hotspot is active and you're within range. You may need to approve the network connection in the system dialog.
                            </Text>
                        </View>
                    )}

                    {errorType === 'ping' && (
                        <View style={styles.errorHintCard}>
                            <MaterialCommunityIcons name="information-outline" size={16} color={COLORS.accent} />
                            <Text style={styles.errorHintText}>
                                Not connected to sender's Wi-Fi.{'\n'}Tap Retry to try again.
                            </Text>
                        </View>
                    )}

                    <View style={[styles.buttonRow, { marginTop: 16 }]}>
                        <TouchableOpacity
                            style={[styles.halfButton]}
                            onPress={resetTransfer}
                        >
                            <MaterialCommunityIcons name="qrcode-scan" size={16} color="#FFF" />
                            <Text style={styles.halfButtonText}>Scan Again</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                            style={[styles.halfButton, { backgroundColor: COLORS.accent }]}
                            onPress={retryConnection}
                        >
                            <MaterialCommunityIcons name="refresh" size={16} color="#FFF" />
                            <Text style={styles.halfButtonText}>Retry</Text>
                        </TouchableOpacity>
                    </View>
                </View>
            )}

            {/* ─── Section: CONNECTED — File List ─── */}
            {status === STATES.CONNECTED && (
                <>
                    <View style={STYLES.card}>
                        <View style={styles.connectedHeader}>
                            <MaterialCommunityIcons name="check-circle" size={24} color={COLORS.success} />
                            <View style={{ marginLeft: 10, flex: 1 }}>
                                <Text style={{ color: COLORS.text, fontWeight: 'bold', fontSize: 16 }}>
                                    Connected to Sender
                                </Text>
                                <Text style={STYLES.subtitle}>
                                    {sender?.ssid ? `${sender.ssid} • ` : ''}{sender?.ip}:{sender?.port}
                                </Text>
                            </View>
                            <View style={styles.connectedBadge}>
                                <MaterialCommunityIcons name="shield-check" size={14} color={COLORS.success} />
                                <Text style={styles.connectedBadgeText}>LAN</Text>
                            </View>
                        </View>
                    </View>

                    <View style={[STYLES.card, styles.marginTop]}>
                        <Text style={STYLES.heading}>Incoming Files ({files.length})</Text>
                        <Text style={[STYLES.subtitle, { marginBottom: 12 }]}>
                            Total: {formatSize(totalSize)}
                        </Text>

                        {files.map((file, idx) => (
                            <View key={idx} style={styles.fileCard}>
                                <MaterialCommunityIcons name="file-outline" size={28} color={COLORS.accent} />
                                <View style={{ marginLeft: 12, flex: 1 }}>
                                    <Text style={styles.fileName} numberOfLines={1}>{file.name}</Text>
                                    <Text style={styles.fileSize}>{formatSize(file.size)}</Text>
                                </View>
                            </View>
                        ))}

                        <TouchableOpacity style={[styles.primaryButton, { marginTop: 16 }]} onPress={startReceiving}>
                            <MaterialCommunityIcons name="download" size={20} color="#FFF" />
                            <Text style={[styles.buttonText, { marginLeft: 8 }]}>Download All Files</Text>
                        </TouchableOpacity>
                    </View>
                </>
            )}

            {/* ─── Section: RECEIVING / COMPLETE ─── */}
            {(status === STATES.RECEIVING || status === STATES.COMPLETE) && (
                <>
                    {/* Connection Info */}
                    <View style={STYLES.card}>
                        <View style={styles.connectedHeader}>
                            <MaterialCommunityIcons
                                name={status === STATES.COMPLETE ? "check-circle" : "download-network"}
                                size={24}
                                color={status === STATES.COMPLETE ? COLORS.success : COLORS.accent}
                            />
                            <View style={{ marginLeft: 10 }}>
                                <Text style={{ color: COLORS.text, fontWeight: 'bold', fontSize: 16 }}>
                                    {status === STATES.COMPLETE ? 'Transfer Complete' : 'Receiving Files...'}
                                </Text>
                                <Text style={STYLES.subtitle}>
                                    From sender at {sender?.ip}
                                </Text>
                            </View>
                        </View>
                    </View>

                    {/* Overall Progress */}
                    <View style={[STYLES.card, styles.marginTop]}>
                        <View style={styles.rowBetween}>
                            <Text style={STYLES.heading}>
                                {status === STATES.COMPLETE ? 'Completed' : 'Overall Progress'}
                            </Text>
                            <Text style={{ color: COLORS.accent, fontWeight: 'bold', fontSize: 16 }}>
                                {Math.round(overallProgress)}%
                            </Text>
                        </View>
                        <View style={styles.progressBarBg}>
                            <View style={[
                                styles.progressBarFill,
                                { width: `${Math.min(overallProgress, 100)}%` },
                                status === STATES.COMPLETE && { backgroundColor: COLORS.success }
                            ]} />
                        </View>
                        <Text style={[STYLES.subtitle, { marginTop: 8 }]}>
                            {formatSize(downloadedSize)} of {formatSize(totalSize)}
                        </Text>
                    </View>

                    {/* Per-File Progress */}
                    <View style={[STYLES.card, styles.marginTop]}>
                        <Text style={STYLES.heading}>Files</Text>
                        {files.map((file, idx) => {
                            const fp = fileProgress[file.name] || { status: 'pending', progress: 0 };
                            return (
                                <View key={idx} style={styles.fileCard}>
                                    <MaterialCommunityIcons
                                        name={
                                            fp.status === 'completed' ? 'file-check-outline' :
                                                fp.status === 'error' ? 'file-alert-outline' :
                                                    fp.status === 'downloading' ? 'file-download-outline' :
                                                        'file-outline'
                                        }
                                        size={28}
                                        color={
                                            fp.status === 'completed' ? COLORS.success :
                                                fp.status === 'error' ? COLORS.error :
                                                    fp.status === 'downloading' ? COLORS.accent :
                                                        COLORS.textSecondary
                                        }
                                    />
                                    <View style={{ marginLeft: 12, flex: 1 }}>
                                        <Text style={styles.fileName} numberOfLines={1}>{file.name}</Text>
                                        <View style={styles.fileMetaRow}>
                                            <Text style={styles.fileSize}>{formatSize(file.size)}</Text>
                                            {fp.status === 'downloading' && (
                                                <Text style={styles.fileProgressText}>{fp.progress}%</Text>
                                            )}
                                            {fp.status === 'error' && (
                                                <Text style={styles.fileErrorText}>Failed</Text>
                                            )}
                                        </View>
                                        {fp.status === 'downloading' && (
                                            <View style={styles.fileProgressBg}>
                                                <View style={[
                                                    styles.fileProgressFill,
                                                    { width: `${fp.progress}%` }
                                                ]} />
                                            </View>
                                        )}
                                    </View>
                                    {fp.status === 'completed' && (
                                        <MaterialCommunityIcons name="check" size={20} color={COLORS.success} />
                                    )}
                                    {fp.status === 'downloading' && (
                                        <ActivityIndicator size="small" color={COLORS.accent} />
                                    )}
                                </View>
                            );
                        })}
                    </View>

                    {/* Reset button */}
                    {status === STATES.COMPLETE && (
                        <TouchableOpacity
                            style={[styles.outlineButton, styles.marginTop]}
                            onPress={resetTransfer}
                        >
                            <MaterialCommunityIcons name="refresh" size={20} color={COLORS.accent} />
                            <Text style={styles.outlineButtonText}>New Transfer</Text>
                        </TouchableOpacity>
                    )}
                </>
            )}

            <View style={{ height: 40 }} />
        </ScrollView>
    );
};

const StepIndicator = ({ step, label }) => (
    <View style={styles.stepItem}>
        <View style={[
            styles.stepDot,
            step >= 1 && styles.activeDot,
            step === 2 && styles.completedDot
        ]}>
            {step === 2 && (
                <MaterialCommunityIcons name="check" size={10} color="#FFF" />
            )}
        </View>
        <Text style={[
            styles.stepText,
            step >= 1 && styles.activeStepText
        ]}>{label}</Text>
    </View>
);

// ═══════════════════════════════════════════════════════════════════════════════
// STYLES
// ═══════════════════════════════════════════════════════════════════════════════
const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: COLORS.background,
    },
    contentContainer: {
        padding: 20,
        paddingTop: 60,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: 20,
    },
    headerTitle: {
        color: COLORS.text,
        fontSize: 20,
        fontWeight: 'bold',
    },
    stepContainer: {
        flexDirection: 'row',
        justifyContent: 'center',
        alignItems: 'center',
        marginBottom: 30,
        backgroundColor: '#161B22',
        padding: 15,
        borderRadius: 12,
    },
    stepItem: {
        alignItems: 'center',
    },
    stepDot: {
        width: 22,
        height: 22,
        borderRadius: 11,
        backgroundColor: '#30363D',
        marginBottom: 6,
        alignItems: 'center',
        justifyContent: 'center',
    },
    activeDot: {
        backgroundColor: COLORS.accent,
        shadowColor: COLORS.accent,
        shadowOpacity: 0.8,
        shadowRadius: 5,
    },
    completedDot: {
        backgroundColor: COLORS.success,
    },
    stepLine: {
        height: 2,
        width: 40,
        backgroundColor: '#30363D',
        marginBottom: 16,
        marginHorizontal: 8,
    },
    stepText: {
        fontSize: 12,
        color: COLORS.textSecondary,
    },
    activeStepText: {
        color: COLORS.text,
        fontWeight: 'bold',
    },
    centerContent: {
        alignItems: 'center',
        justifyContent: 'center',
    },
    scanButton: {
        width: SCREEN_WIDTH - 80,
        height: 200,
        backgroundColor: COLORS.card,
        borderRadius: 20,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 2,
        borderColor: COLORS.accent + '40',
        borderStyle: 'dashed',
    },
    scanButtonText: {
        color: COLORS.text,
        marginTop: 12,
        fontSize: 18,
        fontWeight: 'bold',
    },
    scanSubtext: {
        color: COLORS.textSecondary,
        fontSize: 12,
        marginTop: 4,
    },
    featureBadges: {
        flexDirection: 'row',
        gap: 10,
        marginTop: 20,
    },
    badge: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
        backgroundColor: '#161B22',
        paddingVertical: 6,
        paddingHorizontal: 12,
        borderRadius: 20,
        borderWidth: 1,
        borderColor: '#30363D',
    },
    badgeText: {
        color: COLORS.textSecondary,
        fontSize: 11,
        fontWeight: '500',
    },
    connectionInfoCard: {
        width: '100%',
        backgroundColor: '#0D1117',
        borderRadius: 10,
        padding: 14,
        marginTop: 16,
        borderWidth: 1,
        borderColor: '#30363D',
    },
    infoRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        paddingVertical: 6,
    },
    infoLabel: {
        color: COLORS.textSecondary,
        fontSize: 13,
        fontWeight: '500',
    },
    infoValue: {
        color: COLORS.accent,
        fontSize: 13,
        fontFamily: 'monospace',
        fontWeight: '600',
    },
    errorHintCard: {
        flexDirection: 'row',
        backgroundColor: '#0D1117',
        borderRadius: 10,
        padding: 14,
        marginTop: 16,
        borderWidth: 1,
        borderColor: COLORS.accent + '40',
        gap: 10,
        alignItems: 'flex-start',
    },
    errorHintText: {
        color: COLORS.textSecondary,
        fontSize: 12,
        flex: 1,
        lineHeight: 18,
    },
    buttonRow: {
        flexDirection: 'row',
        gap: 10,
        width: '100%',
        marginTop: 16,
    },
    halfButton: {
        flex: 1,
        flexDirection: 'row',
        backgroundColor: '#30363D',
        paddingVertical: 12,
        borderRadius: 8,
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
    },
    halfButtonText: {
        color: '#FFF',
        fontSize: 13,
        fontWeight: '600',
    },
    connectedHeader: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    connectedBadge: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        backgroundColor: COLORS.success + '20',
        paddingVertical: 4,
        paddingHorizontal: 8,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: COLORS.success + '40',
    },
    connectedBadgeText: {
        color: COLORS.success,
        fontSize: 11,
        fontWeight: '700',
    },
    rowBetween: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: 8,
    },
    primaryButton: {
        backgroundColor: COLORS.accent,
        paddingVertical: 14,
        paddingHorizontal: 24,
        borderRadius: 10,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
    },
    buttonText: {
        color: '#FFF',
        fontSize: 16,
        fontWeight: 'bold',
    },
    outlineButton: {
        borderWidth: 1,
        borderColor: COLORS.accent,
        paddingVertical: 12,
        borderRadius: 8,
        alignItems: 'center',
        flexDirection: 'row',
        justifyContent: 'center',
        gap: 8,
    },
    outlineButtonText: {
        color: COLORS.accent,
        fontSize: 14,
        fontWeight: '600',
    },
    marginTop: {
        marginTop: 20,
    },
    progressBarBg: {
        height: 8,
        backgroundColor: '#30363D',
        borderRadius: 4,
        overflow: 'hidden',
    },
    progressBarFill: {
        height: '100%',
        backgroundColor: COLORS.accent,
        borderRadius: 4,
    },
    fileCard: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: '#0D1117',
        padding: 14,
        borderRadius: 10,
        marginTop: 8,
        borderWidth: 1,
        borderColor: '#30363D',
    },
    fileName: {
        color: COLORS.text,
        fontSize: 14,
        fontWeight: '500',
    },
    fileSize: {
        color: COLORS.textSecondary,
        fontSize: 12,
        marginTop: 2,
    },
    fileMetaRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    fileProgressText: {
        color: COLORS.accent,
        fontSize: 11,
        fontWeight: '600',
        marginTop: 2,
    },
    fileErrorText: {
        color: COLORS.error,
        fontSize: 11,
        fontWeight: '600',
        marginTop: 2,
    },
    fileProgressBg: {
        height: 4,
        backgroundColor: '#30363D',
        borderRadius: 2,
        marginTop: 6,
        overflow: 'hidden',
    },
    fileProgressFill: {
        height: '100%',
        backgroundColor: COLORS.accent,
        borderRadius: 2,
    },
    // Scanner styles
    scannerContainer: {
        flex: 1,
        backgroundColor: '#000',
    },
    scannerOverlay: {
        ...StyleSheet.absoluteFillObject,
        justifyContent: 'space-between',
        alignItems: 'center',
        paddingTop: 60,
        paddingBottom: 80,
    },
    scannerHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        width: '100%',
        paddingHorizontal: 20,
    },
    scannerCloseBtn: {
        width: 40,
        height: 40,
        borderRadius: 20,
        backgroundColor: 'rgba(0,0,0,0.5)',
        alignItems: 'center',
        justifyContent: 'center',
    },
    scannerTitle: {
        color: '#FFF',
        fontSize: 18,
        fontWeight: 'bold',
    },
    scannerFrame: {
        width: 250,
        height: 250,
        position: 'relative',
    },
    corner: {
        position: 'absolute',
        width: 40,
        height: 40,
        borderColor: COLORS.accent,
    },
    topLeft: {
        top: 0, left: 0,
        borderTopWidth: 3, borderLeftWidth: 3,
        borderTopLeftRadius: 12,
    },
    topRight: {
        top: 0, right: 0,
        borderTopWidth: 3, borderRightWidth: 3,
        borderTopRightRadius: 12,
    },
    bottomLeft: {
        bottom: 0, left: 0,
        borderBottomWidth: 3, borderLeftWidth: 3,
        borderBottomLeftRadius: 12,
    },
    bottomRight: {
        bottom: 0, right: 0,
        borderBottomWidth: 3, borderRightWidth: 3,
        borderBottomRightRadius: 12,
    },
    scannerHint: {
        color: 'rgba(255,255,255,0.7)',
        fontSize: 14,
        textAlign: 'center',
        paddingHorizontal: 40,
    },
});

export default ReceiveScreen;
