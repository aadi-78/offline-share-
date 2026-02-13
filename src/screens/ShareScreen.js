
import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
    StyleSheet, Text, View, TouchableOpacity, Alert,
    ScrollView, Animated, NativeModules, NativeEventEmitter,
    Platform, Linking, PermissionsAndroid
} from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import * as DocumentPicker from 'expo-document-picker';
import * as Location from 'expo-location';
import { File, Paths, Directory } from 'expo-file-system';
import QRCode from 'react-native-qrcode-svg';
import { COLORS, STYLES } from '../constants/theme';

const { FileServer, HotspotManager } = NativeModules;
const SERVER_PORT = 3000;

// --- Transfer State Machine ---
// idle → filesSelected → serverStarting → hotspotStarting → hotspotReady →
// networkReady → waitingForReceiver → connected → sending → completed
const STATES = {
    IDLE: 'idle',
    FILES_SELECTED: 'filesSelected',
    SERVER_STARTING: 'serverStarting',
    HOTSPOT_STARTING: 'hotspotStarting',
    HOTSPOT_READY: 'hotspotReady',
    NETWORK_READY: 'networkReady',
    WAITING_FOR_RECEIVER: 'waitingForReceiver',
    CONNECTED: 'connected',
    SENDING: 'sending',
    COMPLETED: 'completed',
    ERROR: 'error',
};

const ShareScreen = ({ onBack }) => {
    const [transferState, setTransferState] = useState(STATES.IDLE);
    const [files, setFiles] = useState([]);
    const [serverIp, setServerIp] = useState('');
    const [hotspotSSID, setHotspotSSID] = useState('');
    const [hotspotPassword, setHotspotPassword] = useState('');
    const [qrValue, setQrValue] = useState('');
    const [receiverConnected, setReceiverConnected] = useState(false);
    const [fileProgress, setFileProgress] = useState({});
    const [overallProgress, setOverallProgress] = useState(0);
    const [errorMsg, setErrorMsg] = useState('');
    const [statusText, setStatusText] = useState('Select files to share');
    const [locationGranted, setLocationGranted] = useState(false);

    const pulseAnim = useRef(new Animated.Value(1)).current;
    const fadeAnim = useRef(new Animated.Value(0)).current;

    const logNetworkInterfaces = async (label = '') => {
        try {
            if (!FileServer?.dumpNetworkInterfaces) {
                console.log('[ShareScreen] dumpNetworkInterfaces() not available');
                return;
            }

            const dump = await FileServer.dumpNetworkInterfaces();
            const rows = Array.isArray(dump)
                ? dump
                : (dump && typeof dump === 'object' ? Object.values(dump) : []);

            console.log(`[ShareScreen] ===== Interface Dump ${label} =====`);
            rows.forEach((row, idx) => {
                const iface = row?.interface ?? 'unknown';
                const ip = row?.ip ?? 'unknown';
                const isUp = Boolean(row?.isUp);
                const isLoopback = Boolean(row?.isLoopback);
                console.log(`[ShareScreen][IF ${idx}] iface=${iface} ip=${ip} isUp=${isUp} loopback=${isLoopback}`);
            });
            console.log('[ShareScreen] ===== End Interface Dump =====');
        } catch (e) {
            console.warn('[ShareScreen] Failed to dump network interfaces:', e);
        }
    };

    // Listen for receiver connection events from native
    useEffect(() => {
        const eventEmitter = new NativeEventEmitter(FileServer);
        const subscription = eventEmitter.addListener('onReceiverConnected', () => {
            setReceiverConnected(true);
            setTransferState(STATES.CONNECTED);
            setStatusText('Receiver connected!');
        });

        return () => {
            subscription.remove();
        };
    }, []);

    // Pulse animation when waiting
    useEffect(() => {
        if (transferState === STATES.WAITING_FOR_RECEIVER) {
            Animated.loop(
                Animated.sequence([
                    Animated.timing(pulseAnim, {
                        toValue: 1.3,
                        duration: 800,
                        useNativeDriver: true,
                    }),
                    Animated.timing(pulseAnim, {
                        toValue: 1,
                        duration: 800,
                        useNativeDriver: true,
                    })
                ])
            ).start();
        } else {
            pulseAnim.setValue(1);
        }
    }, [transferState]);

    // Fade in QR code
    useEffect(() => {
        if (qrValue) {
            Animated.timing(fadeAnim, {
                toValue: 1,
                duration: 500,
                useNativeDriver: true,
            }).start();
        } else {
            fadeAnim.setValue(0);
        }
    }, [qrValue]);

    // Cleanup on unmount — stop server + hotspot
    useEffect(() => {
        return () => {
            FileServer.stopServer().catch(() => { });
            HotspotManager.stopHotspot().catch(() => { });
        };
    }, []);

    // ─── Permission Management ────────────────────────────────────
    const requestPermissions = async () => {
        if (Platform.OS !== 'android') return true;

        const version = Platform.Version;
        const finePerm = PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION;
        const coarsePerm = PermissionsAndroid.PERMISSIONS.ACCESS_COARSE_LOCATION;
        const nearbyPerm = PermissionsAndroid.PERMISSIONS.NEARBY_WIFI_DEVICES;
        const perms = [
            finePerm,
            coarsePerm
        ];

        // Android 13+ (API 33) requires NEARBY_WIFI_DEVICES for hotspots
        if (version >= 33 && nearbyPerm) {
            perms.push(nearbyPerm);
        }

        try {
            console.log('[ShareScreen] Requesting permissions:', perms);
            const result = await PermissionsAndroid.requestMultiple(perms);
            console.log('[ShareScreen] Permission result:', result);

            // Re-check final state to avoid edge-cases in requestMultiple response maps
            const finalChecks = await Promise.all(perms.map(p => PermissionsAndroid.check(p)));
            const grantedMap = Object.fromEntries(perms.map((p, i) => [p, finalChecks[i]]));

            const locationGranted = Boolean(grantedMap[finePerm] && grantedMap[coarsePerm]);

            let nearbyGranted = true;
            if (version >= 33 && nearbyPerm) {
                nearbyGranted = Boolean(grantedMap[nearbyPerm]);
            }

            if (locationGranted && nearbyGranted) {
                setLocationGranted(true);
                return true;
            } else {
                Alert.alert(
                    'Permissions Missing',
                    'OffShare needs Location and Nearby Devices permissions to create a hotspot.\n\nPlease grant them in Settings.',
                    [
                        { text: 'Open Settings', onPress: () => Linking.openSettings() },
                        { text: 'Cancel', style: 'cancel' }
                    ]
                );
                return false;
            }
        } catch (err) {
            console.warn('Permission request error:', err);
            return false;
        }
    };

    // ─── Location Services Check ──────────────────────────────────
    const ensureLocationServices = async () => {
        try {
            const enabled = await HotspotManager.isLocationEnabled();
            if (enabled) return true;

            // Show blocking alert
            return new Promise((resolve) => {
                Alert.alert(
                    'Enable Location Services',
                    'Location Services (GPS) must be turned ON to create a Wi-Fi hotspot.\n\n' +
                    'Please enable Location in your device settings, then come back and try again.',
                    [
                        {
                            text: 'Open Location Settings',
                            onPress: () => {
                                Linking.sendIntent('android.settings.LOCATION_SOURCE_SETTINGS').catch(() => {
                                    Linking.openSettings();
                                });
                                resolve(false);
                            }
                        },
                        {
                            text: 'Cancel',
                            style: 'cancel',
                            onPress: () => resolve(false)
                        },
                    ],
                    { cancelable: false }
                );
            });
        } catch (e) {
            console.warn('Location services check error:', e);
            return false;
        }
    };

    // ─── File Picker ──────────────────────────────────────────────
    const pickFiles = async () => {
        try {
            const result = await DocumentPicker.getDocumentAsync({
                type: '*/*',
                copyToCacheDirectory: true,
                multiple: true,
            });

            if (result.assets && result.assets.length > 0) {
                const cacheDir = new Directory(Paths.cache, 'offshare');
                if (!cacheDir.exists) {
                    cacheDir.create();
                }

                const processedFiles = [];
                for (const asset of result.assets) {
                    try {
                        const destFile = new File(cacheDir, asset.name);
                        const srcFile = new File(asset.uri);

                        if (destFile.exists) {
                            destFile.delete();
                        }
                        srcFile.copy(destFile);

                        // Decode URI path: expo URIs use %20 for spaces,
                        // but filesystem needs actual spaces
                        const rawUri = destFile.uri.replace('file://', '');
                        const decodedPath = decodeURIComponent(rawUri);

                        console.log('[ShareScreen] File picked:', {
                            name: asset.name,
                            rawUri,
                            decodedPath,
                        });

                        processedFiles.push({
                            name: asset.name,       // raw name, never encoded
                            size: asset.size,
                            uri: asset.uri,
                            nativePath: decodedPath, // decoded filesystem path
                        });
                    } catch (copyErr) {
                        console.warn('Failed to copy file:', asset.name, copyErr);
                        const rawUri = asset.uri.replace('file://', '');
                        const decodedPath = decodeURIComponent(rawUri);

                        processedFiles.push({
                            name: asset.name,
                            size: asset.size,
                            uri: asset.uri,
                            nativePath: decodedPath,
                        });
                    }
                }

                setFiles(prev => [...prev, ...processedFiles]);
                if (transferState === STATES.IDLE) {
                    setTransferState(STATES.FILES_SELECTED);
                }
            }
        } catch (err) {
            console.warn('File pick error:', err);
        }
    };

    // ─── The Main Flow: Start Everything ──────────────────────────
    const startSharing = async () => {
        if (files.length === 0) {
            Alert.alert('No Files', 'Please select files first.');
            return;
        }

        // Step 1: Check ALL permissions
        const hasPermissions = await requestPermissions();
        if (!hasPermissions) return;

        // Step 2: Ensure Location Services (GPS) is ON
        const locationOn = await ensureLocationServices();
        if (!locationOn) return;

        try {
            // Step 3: Start LocalOnlyHotspot FIRST (before server)
            // This way we don't waste starting the server if hotspot fails
            setTransferState(STATES.HOTSPOT_STARTING);
            setStatusText('Starting hotspot...');

            const hotspotResult = await HotspotManager.startHotspot();
            console.log('[ShareScreen] Hotspot started:', hotspotResult);

            await logNetworkInterfaces('(after hotspot start)');

            // Step 4: Start NanoHTTPD Server
            setTransferState(STATES.SERVER_STARTING);
            setStatusText('Starting file server...');

            const filePaths = files.map(f => f.nativePath);
            const serverResult = await FileServer.startServer(SERVER_PORT, filePaths);
            console.log('[ShareScreen] Server started:', serverResult);

            setHotspotSSID(hotspotResult.ssid || '');
            setHotspotPassword(hotspotResult.password || '');
            setTransferState(STATES.HOTSPOT_READY);
            setStatusText('Hotspot ready, detecting IP...');

            // Step 4: Dynamic IPv4 Detection (hotspot already waited 1500ms in native)
            const ip = await FileServer.getLocalIPv4();
            console.log('[ShareScreen] Detected IP:', ip);

            if (!ip) {
                throw new Error('Could not detect local IP address. Please try again.');
            }

            setServerIp(ip);
            setTransferState(STATES.NETWORK_READY);

            // Step 5: Generate QR — MUST be strict JSON
            const qrPayload = {
                ssid: hotspotResult.ssid || '',
                password: hotspotResult.password || '',
                ip: ip,
                port: SERVER_PORT,
                filesEndpoint: '/files',
                downloadEndpoint: '/download',
                deviceName: 'OffShare Sender',
            };
            const qrData = qrPayload;
            console.log('[ShareScreen] QR Payload:', qrData);
            setQrValue(qrData);
            setTransferState(STATES.WAITING_FOR_RECEIVER);
            setStatusText('Scan the QR code from receiver device');

        } catch (e) {
            console.error('[ShareScreen] Start sharing failed:', e);
            setErrorMsg(e.message || 'Failed to start sharing');
            setTransferState(STATES.ERROR);
            setStatusText('Error — tap to retry');

            // Cleanup on failure
            FileServer.stopServer().catch(() => { });
            HotspotManager.stopHotspot().catch(() => { });
        }
    };

    // ─── Stop Everything ──────────────────────────────────────────
    const stopSharing = async () => {
        try {
            await FileServer.stopServer();
        } catch (e) { console.warn('Stop server error:', e); }
        try {
            await HotspotManager.stopHotspot();
        } catch (e) { console.warn('Stop hotspot error:', e); }

        setTransferState(STATES.IDLE);
        setQrValue('');
        setReceiverConnected(false);
        setServerIp('');
        setHotspotSSID('');
        setHotspotPassword('');
        setFileProgress({});
        setOverallProgress(0);
        setErrorMsg('');
        setStatusText('Select files to share');
    };

    const resetTransfer = () => {
        stopSharing();
        setFiles([]);
    };

    // ─── Helpers ──────────────────────────────────────────────────
    const formatSize = (bytes) => {
        if (!bytes) return '0 B';
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
    };

    const getStepProgress = () => {
        const stateIndex = Object.values(STATES).indexOf(transferState);
        return {
            files: files.length > 0 ? 1 : 0,
            server: stateIndex >= 3 ? 1 : (stateIndex >= 2 ? 0.5 : 0),
            hotspot: stateIndex >= 5 ? 1 : (stateIndex >= 3 ? 0.5 : 0),
            receiver: receiverConnected ? 1 : (stateIndex >= 6 ? 0.5 : 0),
        };
    };

    const isProcessing = [
        STATES.SERVER_STARTING,
        STATES.HOTSPOT_STARTING,
        STATES.HOTSPOT_READY,
        STATES.NETWORK_READY,
    ].includes(transferState);

    const isActive = ![STATES.IDLE, STATES.FILES_SELECTED, STATES.ERROR].includes(transferState);

    const stepProgress = getStepProgress();

    return (
        <ScrollView style={styles.container} contentContainerStyle={styles.contentContainer}>
            {/* Header */}
            <View style={styles.header}>
                <TouchableOpacity onPress={onBack}>
                    <MaterialCommunityIcons name="arrow-left" size={24} color={COLORS.text} />
                </TouchableOpacity>
                <Text style={styles.headerTitle}>Share Files</Text>
                <View style={{ width: 24 }} />
            </View>

            {/* Step Indicator */}
            <View style={styles.stepContainer}>
                <StepIndicator step={stepProgress.files} label="Files" />
                <View style={styles.stepLine} />
                <StepIndicator step={stepProgress.server} label="Server" />
                <View style={styles.stepLine} />
                <StepIndicator step={stepProgress.hotspot} label="Hotspot" />
                <View style={styles.stepLine} />
                <StepIndicator step={stepProgress.receiver} label="Receiver" />
            </View>

            {/* Status Banner */}
            <View style={[styles.statusBanner, isActive && styles.statusBannerActive, transferState === STATES.ERROR && styles.statusBannerError]}>
                <MaterialCommunityIcons
                    name={
                        transferState === STATES.ERROR ? 'alert-circle' :
                            transferState === STATES.COMPLETED ? 'check-circle' :
                                isProcessing ? 'loading' :
                                    receiverConnected ? 'check-network' :
                                        transferState === STATES.WAITING_FOR_RECEIVER ? 'radar' :
                                            'information'
                    }
                    size={18}
                    color={
                        transferState === STATES.ERROR ? COLORS.error :
                            transferState === STATES.COMPLETED ? COLORS.success :
                                COLORS.accent
                    }
                />
                <Text style={[
                    styles.statusText,
                    transferState === STATES.ERROR && { color: COLORS.error }
                ]}>
                    {statusText}
                </Text>
            </View>

            {/* Error Section */}
            {transferState === STATES.ERROR && (
                <View style={[STYLES.card, styles.marginTop, styles.centerContent]}>
                    <MaterialCommunityIcons name="alert-circle-outline" size={48} color={COLORS.error} />
                    <Text style={[STYLES.heading, { color: COLORS.error, textAlign: 'center' }]}>
                        Something went wrong
                    </Text>
                    <Text style={[STYLES.subtitle, { textAlign: 'center', marginTop: 8 }]}>
                        {errorMsg}
                    </Text>
                    <TouchableOpacity
                        style={[styles.primaryButton, { marginTop: 16 }]}
                        onPress={startSharing}
                    >
                        <MaterialCommunityIcons name="refresh" size={18} color="#FFF" />
                        <Text style={styles.buttonText}>  Retry</Text>
                    </TouchableOpacity>
                </View>
            )}

            {/* Section: File Picker */}
            <View style={[STYLES.card, styles.marginTop]}>
                <View style={styles.rowBetween}>
                    <Text style={STYLES.heading}>Selected Files ({files.length})</Text>
                    {files.length > 0 && !isActive && (
                        <TouchableOpacity onPress={() => { setFiles([]); setTransferState(STATES.IDLE); }}>
                            <Text style={{ color: COLORS.error, fontSize: 13 }}>Clear All</Text>
                        </TouchableOpacity>
                    )}
                </View>

                {!isActive && (
                    <TouchableOpacity style={styles.outlineButton} onPress={pickFiles}>
                        <MaterialCommunityIcons name="file-plus" size={20} color={COLORS.accent} />
                        <Text style={styles.outlineButtonText}>Choose Files</Text>
                    </TouchableOpacity>
                )}

                {files.map((file, index) => (
                    <View key={index} style={styles.fileItem}>
                        <MaterialCommunityIcons name="file-outline" size={24} color={COLORS.textSecondary} />
                        <View style={styles.fileInfo}>
                            <Text style={styles.fileName} numberOfLines={1}>{file.name}</Text>
                            <Text style={styles.fileSize}>{formatSize(file.size)}</Text>
                        </View>
                        {transferState === STATES.SENDING && (
                            <View style={styles.fileProgressContainer}>
                                <View
                                    style={[
                                        styles.fileProgressBar,
                                        { width: `${fileProgress[file.name] || 0}%` }
                                    ]}
                                />
                            </View>
                        )}
                        {transferState === STATES.COMPLETED && (
                            <MaterialCommunityIcons name="check-circle" size={20} color={COLORS.success} />
                        )}
                    </View>
                ))}
            </View>

            {/* Start Sharing Button */}
            {files.length > 0 && !isActive && transferState !== STATES.ERROR && (
                <TouchableOpacity
                    style={[styles.primaryButton, styles.marginTop]}
                    onPress={startSharing}
                >
                    <MaterialCommunityIcons name="access-point" size={20} color="#FFF" />
                    <Text style={styles.buttonText}>  Start Sharing</Text>
                </TouchableOpacity>
            )}

            {/* Processing State */}
            {isProcessing && (
                <View style={[STYLES.card, styles.marginTop, styles.centerContent]}>
                    <Animated.View style={{ transform: [{ scale: pulseAnim }] }}>
                        <MaterialCommunityIcons name="loading" size={48} color={COLORS.accent} />
                    </Animated.View>
                    <Text style={[STYLES.heading, { textAlign: 'center', marginTop: 12 }]}>
                        Setting up...
                    </Text>
                    <Text style={[STYLES.subtitle, { textAlign: 'center' }]}>
                        {transferState === STATES.SERVER_STARTING && 'Starting file server on port 3000...'}
                        {transferState === STATES.HOTSPOT_STARTING && 'Creating Wi-Fi hotspot...'}
                        {transferState === STATES.HOTSPOT_READY && 'Hotspot ready, detecting network...'}
                        {transferState === STATES.NETWORK_READY && 'Generating QR code...'}
                    </Text>
                </View>
            )}

            {/* QR Code Display */}
            {qrValue !== '' && (
                <Animated.View style={[STYLES.card, styles.marginTop, styles.centerContent, { opacity: fadeAnim }]}>
                    {receiverConnected ? (
                        <>
                            <MaterialCommunityIcons name="check-circle-outline" size={60} color={COLORS.success} />
                            <Text style={[STYLES.heading, { textAlign: 'center' }]}>Receiver Connected</Text>
                            <Text style={STYLES.subtitle}>Ready to transfer files</Text>
                        </>
                    ) : (
                        <>
                            <Text style={[STYLES.heading, { marginBottom: 16, textAlign: 'center', padding: 32 }]}>
                                Scan to Connect
                            </Text>
                            <View style={styles.qrContainer}>
                                <QRCode
                                    value={JSON.stringify(JSON.stringify(qrValue))}
                                    size={260}
                                    backgroundColor="#FFF"
                                    color="#000"
                                />
                            </View>

                            {/* Connection Info */}
                            <View style={styles.connectionInfo}>
                                <View style={styles.infoRow}>
                                    <Text style={styles.infoLabel}>Network:</Text>
                                    <Text style={styles.infoValue}>{hotspotSSID}</Text>
                                </View>
                                <View style={styles.infoRow}>
                                    <Text style={styles.infoLabel}>Password:</Text>
                                    <Text style={styles.infoValue}>{hotspotPassword}</Text>
                                </View>
                                <View style={styles.infoRow}>
                                    <Text style={styles.infoLabel}>Server:</Text>
                                    <Text style={styles.infoValue}>{serverIp}:{SERVER_PORT}</Text>
                                </View>
                            </View>

                            <Text style={[STYLES.subtitle, { marginTop: 12, textAlign: 'center' }]}>
                                Waiting for receiver to scan...
                            </Text>
                            <Animated.View style={{ transform: [{ scale: pulseAnim }] }}>
                                <MaterialCommunityIcons
                                    name="radar"
                                    size={32}
                                    color={COLORS.accent}
                                    style={styles.pulseIcon}
                                />
                            </Animated.View>
                        </>
                    )}
                </Animated.View>
            )}

            {/* Overall Progress */}
            {(transferState === STATES.SENDING || transferState === STATES.COMPLETED) && (
                <View style={[STYLES.card, styles.marginTop]}>
                    <View style={styles.rowBetween}>
                        <Text style={STYLES.heading}>Transfer Progress</Text>
                        <Text style={{ color: COLORS.accent, fontWeight: 'bold', fontSize: 16 }}>
                            {overallProgress}%
                        </Text>
                    </View>
                    <View style={styles.overallProgressBg}>
                        <Animated.View
                            style={[
                                styles.overallProgressFill,
                                { width: `${overallProgress}%` },
                                transferState === STATES.COMPLETED && { backgroundColor: COLORS.success }
                            ]}
                        />
                    </View>
                    <Text style={[STYLES.subtitle, { marginTop: 8 }]}>
                        {transferState === STATES.COMPLETED
                            ? `All ${files.length} files sent successfully`
                            : `Sending ${files.length} files...`}
                    </Text>
                </View>
            )}

            {/* Stop / Reset */}
            {isActive && (
                <TouchableOpacity
                    style={[styles.dangerButton, styles.marginTop]}
                    onPress={transferState === STATES.COMPLETED ? resetTransfer : stopSharing}
                >
                    <Text style={styles.dangerButtonText}>
                        {transferState === STATES.COMPLETED ? 'New Transfer' : 'Stop Sharing'}
                    </Text>
                </TouchableOpacity>
            )}

            <View style={{ height: 40 }} />
        </ScrollView>
    );
};

const StepIndicator = ({ step, label }) => (
    <View style={styles.stepItem}>
        <View style={[
            styles.stepDot,
            step > 0 && styles.activeDot,
            step >= 1 && styles.completedDot,
        ]}>
            {step >= 1 && (
                <MaterialCommunityIcons name="check" size={10} color="#FFF" />
            )}
        </View>
        <Text style={[styles.stepText, step > 0 && styles.activeStepText]}>{label}</Text>
    </View>
);

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
        marginBottom: 24,
        paddingHorizontal: 10,
    },
    stepItem: {
        alignItems: 'center',
    },
    stepDot: {
        width: 22,
        height: 22,
        borderRadius: 11,
        backgroundColor: '#30363D',
        marginBottom: 4,
        alignItems: 'center',
        justifyContent: 'center',
    },
    activeDot: {
        backgroundColor: COLORS.accent,
    },
    completedDot: {
        backgroundColor: COLORS.success,
    },
    stepLine: {
        height: 2,
        width: 30,
        backgroundColor: '#30363D',
        marginBottom: 14,
    },
    stepText: {
        fontSize: 10,
        color: COLORS.textSecondary,
    },
    activeStepText: {
        color: COLORS.accent,
        fontWeight: 'bold',
    },
    statusBanner: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: '#161B22',
        padding: 12,
        borderRadius: 10,
        marginBottom: 8,
        gap: 8,
        borderWidth: 1,
        borderColor: '#30363D',
    },
    statusBannerActive: {
        borderColor: COLORS.accent + '50',
        backgroundColor: COLORS.accent + '10',
    },
    statusBannerError: {
        borderColor: COLORS.error + '50',
        backgroundColor: COLORS.error + '10',
    },
    statusText: {
        color: COLORS.text,
        fontSize: 14,
        fontWeight: '500',
        flex: 1,
    },
    rowBetween: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: 12,
    },
    primaryButton: {
        backgroundColor: COLORS.accent,
        paddingVertical: 14,
        borderRadius: 10,
        alignItems: 'center',
        flexDirection: 'row',
        justifyContent: 'center',
    },
    buttonText: {
        color: '#FFF',
        fontSize: 16,
        fontWeight: 'bold',
    },
    dangerButton: {
        backgroundColor: 'transparent',
        borderWidth: 1,
        borderColor: COLORS.error,
        paddingVertical: 12,
        borderRadius: 8,
        alignItems: 'center',
    },
    dangerButtonText: {
        color: COLORS.error,
        fontSize: 14,
        fontWeight: '600',
    },
    outlineButton: {
        borderWidth: 1,
        borderColor: COLORS.accent + '60',
        borderStyle: 'dashed',
        paddingVertical: 12,
        borderRadius: 8,
        alignItems: 'center',
        flexDirection: 'row',
        justifyContent: 'center',
        gap: 8,
        marginBottom: 16,
    },
    outlineButtonText: {
        color: COLORS.accent,
        fontSize: 14,
        fontWeight: '600',
    },
    marginTop: {
        marginTop: 20,
    },
    fileItem: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: '#0D1117',
        padding: 12,
        borderRadius: 8,
        marginBottom: 8,
        borderWidth: 1,
        borderColor: '#30363D',
    },
    fileInfo: {
        marginLeft: 10,
        flex: 1,
    },
    fileName: {
        color: COLORS.text,
        fontSize: 14,
    },
    fileSize: {
        color: COLORS.textSecondary,
        fontSize: 12,
        marginTop: 2,
    },
    fileProgressContainer: {
        width: 50,
        height: 4,
        backgroundColor: '#30363D',
        borderRadius: 2,
        overflow: 'hidden',
    },
    fileProgressBar: {
        height: '100%',
        backgroundColor: COLORS.accent,
        borderRadius: 2,
    },
    centerContent: {
        alignItems: 'center',
        paddingVertical: 24,
    },
    qrContainer: {
        padding: 16,
        backgroundColor: '#FFF',
        borderRadius: 12,
    },
    connectionInfo: {
        marginTop: 16,
        width: '100%',
        backgroundColor: '#0D1117',
        borderRadius: 10,
        padding: 14,
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
    pulseIcon: {
        marginTop: 16,
        opacity: 0.8,
    },
    overallProgressBg: {
        height: 8,
        backgroundColor: '#30363D',
        borderRadius: 4,
        overflow: 'hidden',
    },
    overallProgressFill: {
        height: '100%',
        backgroundColor: COLORS.accent,
        borderRadius: 4,
    },
});

export default ShareScreen;
