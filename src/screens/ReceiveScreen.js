import React, { useState, useRef, useCallback, useEffect } from 'react';
import {
    StyleSheet, Text, View, TouchableOpacity, ScrollView,
    Alert, Animated, Dimensions, NativeModules, NativeEventEmitter, PermissionsAndroid, Platform, ActivityIndicator, Linking
} from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { COLORS, STYLES } from '../constants/theme';
import { StorageAccessFramework } from 'expo-file-system/legacy';
import * as Device from 'expo-device';
import AsyncStorage from '@react-native-async-storage/async-storage';

const { NearbyManager, SafTransfer } = NativeModules;
const nearbyEvents = new NativeEventEmitter(NearbyManager);

const STATES = {
    IDLE: 'idle',
    DISCOVERING: 'discovering',
    DEVICE_LIST: 'deviceList',
    CONNECTING: 'connecting',
    CONNECTED: 'connected',
    RECEIVING: 'receiving',
    COMPLETE: 'complete',
    ERROR: 'error',
};

const ReceiveScreen = ({ onBack }) => {
    const [status, setStatus] = useState(STATES.IDLE);
    const [nearbyDevices, setNearbyDevices] = useState([]);
    const [selectedDevice, setSelectedDevice] = useState(null);
    const [incomingFiles, setIncomingFiles] = useState([]); // Array of { payloadId, name, size, uri }
    const [overallProgress, setOverallProgress] = useState(0);
    const [fileProgress, setFileProgress] = useState({});
    const [errorMsg, setErrorMsg] = useState('');
    const [safDirUri, setSafDirUri] = useState(null);
    const safDirUriRef = useRef(null);

    // Animation Refs
    const pulseAnim = useRef(new Animated.Value(1)).current;

    // Pulse animation
    useEffect(() => {
        if (status === STATES.DISCOVERING || status === STATES.CONNECTING) {
            Animated.loop(
                Animated.sequence([
                    Animated.timing(pulseAnim, {
                        toValue: 1.2,
                        duration: 1000,
                        useNativeDriver: true,
                    }),
                    Animated.timing(pulseAnim, {
                        toValue: 1,
                        duration: 1000,
                        useNativeDriver: true,
                    })
                ])
            ).start();
        } else {
            pulseAnim.setValue(1);
        }
    }, [status]);

    const requestPermissions = async () => {
        if (Platform.OS === 'android') {
            // Request ALL permissions needed for Nearby Connections
            const permissions = [
                PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
                PermissionsAndroid.PERMISSIONS.ACCESS_COARSE_LOCATION, // Required for Nearby
            ];

            // Add Bluetooth permissions for Android 12+ (API 31+)
            if (Platform.Version >= 31) {
                permissions.push(
                    PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
                    PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
                    PermissionsAndroid.PERMISSIONS.BLUETOOTH_ADVERTISE
                );
            }

            // Add Nearby Wi-Fi for Android 13+ (API 33+)
            if (Platform.Version >= 33) {
                permissions.push(PermissionsAndroid.PERMISSIONS.NEARBY_WIFI_DEVICES);
            }

            try {
                const granted = await PermissionsAndroid.requestMultiple(permissions);
                const allGranted = Object.values(granted).every(status => status === PermissionsAndroid.RESULTS.GRANTED);

                if (!allGranted) {
                    const denied = Object.entries(granted)
                        .filter(([_, status]) => status !== PermissionsAndroid.RESULTS.GRANTED)
                        .map(([perm, _]) => perm);
                    console.warn("Denied permissions:", denied);
                }

                return allGranted;
            } catch (err) {
                console.warn("Permission request error:", err);
                return false;
            }
        }
        return true;
    };

    // Setup SAF
    const setupSaf = async () => {
        // Check if we already have it in state
        if (safDirUri) {
            safDirUriRef.current = safDirUri;
            console.log('📁 Folder in use:', safDirUri);
            return safDirUri;
        }

        // Try to load from AsyncStorage (optional - won't crash if fails)
        try {
            if (AsyncStorage) {
                const savedUri = await AsyncStorage.getItem('@saf_directory_uri');
                if (savedUri) {
                    setSafDirUri(savedUri);
                    safDirUriRef.current = savedUri;
                    console.log('📁 Folder in use (from storage):', savedUri);
                    return savedUri;
                }
            }
        } catch (e) {
            console.warn('AsyncStorage not available or failed to load:', e.message);
            // Continue without saved URI
        }

        // No saved URI, request folder selection
        try {
            // Try specific path first
            const permissions = await StorageAccessFramework.requestDirectoryPermissionsAsync('content://com.android.externalstorage.documents/tree/primary%3ADownload%2FOffShare');
            if (permissions.granted) {
                setSafDirUri(permissions.directoryUri);
                safDirUriRef.current = permissions.directoryUri;

                // Try to save to AsyncStorage (non-blocking)
                try {
                    if (AsyncStorage) {
                        await AsyncStorage.setItem('@saf_directory_uri', permissions.directoryUri);
                        console.log('✅ Folder selected for the first time:', permissions.directoryUri);
                    }
                } catch (saveErr) {
                    console.warn('Failed to save to AsyncStorage:', saveErr.message);
                }

                console.log('📁 Folder in use:', permissions.directoryUri);
                return permissions.directoryUri;
            }
        } catch (e) {
            console.log("SAF specific URI failed, trying default...", e);
            try {
                // Fallback to default picker
                const permissions = await StorageAccessFramework.requestDirectoryPermissionsAsync(null);
                if (permissions.granted) {
                    setSafDirUri(permissions.directoryUri);
                    safDirUriRef.current = permissions.directoryUri;

                    // Try to save to AsyncStorage (non-blocking)
                    try {
                        if (AsyncStorage) {
                            await AsyncStorage.setItem('@saf_directory_uri', permissions.directoryUri);
                            console.log('✅ Folder selected for the first time:', permissions.directoryUri);
                        }
                    } catch (saveErr) {
                        console.warn('Failed to save to AsyncStorage:', saveErr.message);
                    }

                    console.log('📁 Folder in use:', permissions.directoryUri);
                    return permissions.directoryUri;
                }
            } catch (err) {
                console.warn("SAF setup failed completely", err);
            }
        }
        return null;
    };

    useEffect(() => {
        const subscriptions = [];

        subscriptions.push(nearbyEvents.addListener('onEndpointFound', (event) => {
            // event: { endpointId, endpointName, serviceId }
            setNearbyDevices(prev => {
                if (prev.find(d => d.id === event.endpointId)) return prev;
                return [...prev, { id: event.endpointId, name: event.endpointName, type: 'phone' }];
            });
            setStatus(prevStatus => {
                if (prevStatus === STATES.DISCOVERING) {
                    return STATES.DEVICE_LIST;
                }
                return prevStatus;
            });
        }));

        subscriptions.push(nearbyEvents.addListener('onEndpointLost', (event) => {
            setNearbyDevices(prev => prev.filter(d => d.id !== event.endpointId));
        }));

        subscriptions.push(nearbyEvents.addListener('onConnectionInitiated', async (event) => {
            // Sender requested connection. We are receiver, so we usually request connection.
            // But if we are discoverer, we initiate.
            // Actually, Discoverer calls requestConnection. Advertiser calls acceptConnection.
            // Wait, user flow: "Tap device -> call requestConnection(endpointId)".
            // So Receiver calls requestConnection.
            // Then Advertiser (Sender) accepts.
            // Then Receiver receives onConnectionInitiated? Yes, both sides receive it.
            // Receiver implementation:
            Alert.alert(
                'Connection Request',
                `Accept connection to ${event.endpointName}?`,
                [
                    { text: 'Reject', onPress: () => NearbyManager.rejectConnection(event.endpointId) },
                    { text: 'Accept', onPress: () => NearbyManager.acceptConnection(event.endpointId) }
                ]
            );
        }));

        subscriptions.push(nearbyEvents.addListener('onConnectionResult', (event) => {
            if (event.status === 'CONNECTED') {
                setStatus(STATES.CONNECTED);
            } else if (event.status !== 'CONNECTED') {
                setStatus(STATES.ERROR);
                setErrorMsg('Connection failed');
            }
        }));

        subscriptions.push(nearbyEvents.addListener('onPayloadReceived', (event) => {
            if (event.type === 'metadata') {
                setIncomingFiles(prev => [...prev, {
                    payloadId: event.filePayloadId,
                    name: event.fileName,
                    size: parseInt(event.fileSize),
                    status: 'pending'
                }]);
                setStatus(prevStatus => {
                    if (prevStatus === STATES.CONNECTED) {
                        return STATES.RECEIVING;
                    }
                    return prevStatus;
                });
            }
        }));

        subscriptions.push(nearbyEvents.addListener('onPayloadTransferUpdate', (event) => {
            // event: { payloadId, bytesTransferred, totalBytes, status, filePath?, payloadType?, fileName? }

            // Skip BYTES payload updates (metadata) — only track FILE payloads
            if (event.payloadType === 'BYTES') {
                return;
            }

            // Update progress for FILE payloads only
            setFileProgress(prev => ({
                ...prev,
                [event.payloadId]: (event.bytesTransferred / event.totalBytes) * 100
            }));

            // Update incoming file status
            if (event.status === 'SUCCESS') {
                console.log(`✅ FILE Payload ${event.payloadId} transfer SUCCESS, filePath: ${event.filePath}, fileName: ${event.fileName}`);
                // Update file status to completed
                setIncomingFiles(prev => {
                    const updated = prev.map(f =>
                        f.payloadId === event.payloadId
                            ? { ...f, status: 'completed', filePath: event.filePath }
                            : f
                    );

                    // Save to SAF right here where we have current state
                    if (event.filePath) {
                        const fileInfo = updated.find(f => f.payloadId === event.payloadId);
                        const dirUri = safDirUriRef.current;
                        // Use fileInfo.name from metadata, or fallback to event.fileName from native
                        const fileName = fileInfo?.name || event.fileName || `received_${Date.now()}`;
                        if (dirUri) {
                            (async () => {
                                try {
                                    const mimeType = 'application/octet-stream';
                                    console.log(`📄 Creating SAF file: ${fileName} in ${dirUri}`);
                                    const newFileUri = await StorageAccessFramework.createFileAsync(dirUri, fileName, mimeType);
                                    console.log(`📄 SAF file created: ${newFileUri}`);
                                    await SafTransfer.copyFileToContentUri('file://' + event.filePath, newFileUri);
                                    console.log(`💾 FILE SAVED ${dirUri}/${fileName}`);
                                } catch (e) {
                                    console.error(`❌ Failed to save ${fileName}:`, e);
                                }
                            })();
                        } else {
                            console.warn(`⚠️ Cannot save file: dirUri=${dirUri}, fileInfo=${!!fileInfo}`);
                        }
                    }

                    return updated;
                });
            } else if (event.status === 'FAILURE') {
                setIncomingFiles(prev => prev.map(f =>
                    f.payloadId === event.payloadId
                        ? { ...f, status: 'failed' }
                        : f
                ));
            }
        }));

        return () => {
            subscriptions.forEach(sub => sub.remove());
            NearbyManager.stopAll();
        };
    }, []); // Empty dependencies - event listeners use setState with callbacks

    // handleFileSave is now inlined in the event listener above to avoid stale closure issues

    // Check for completion
    useEffect(() => {
        if (incomingFiles.length > 0 && status === STATES.RECEIVING) {
            const allCompleted = incomingFiles.every(f => f.status === 'completed' || f.status === 'failed');
            if (allCompleted) {
                setStatus(STATES.COMPLETE);
            }
        }
    }, [incomingFiles, status]);

    // ─── Actions ──────────────────────────────────────────────────

    const startDiscovery = async () => {
        const hasPermissions = await requestPermissions();
        if (!hasPermissions) {
            Alert.alert(
                "Permissions Required",
                "Please grant all permissions to use Nearby Connections.",
                [{ text: "OK" }]
            );
            return;
        }

        // Check All Files Access (needed to read received files from .nearby directory)
        try {
            const hasAllFiles = await NearbyManager.isAllFilesAccessGranted();
            if (!hasAllFiles) {
                Alert.alert(
                    "All Files Access Required",
                    "OffShare needs access to read received files from the Nearby transfer directory. Please enable 'All files access' for OffShare on the next screen.",
                    [
                        { text: "Cancel", style: "cancel" },
                        {
                            text: "Grant Access",
                            onPress: () => {
                                NearbyManager.requestAllFilesAccess();
                            }
                        }
                    ]
                );
                return;
            }
        } catch (e) {
            console.warn("All Files Access check failed:", e);
            // Continue anyway on older Android versions
        }

        const uri = await setupSaf();
        if (!uri) {
            Alert.alert(
                "Select Folder",
                "Please select a folder to save received files.",
                [
                    { text: "Cancel", style: "cancel" },
                    { text: "Select Folder", onPress: startDiscovery }
                ]
            );
            return;
        }

        setNearbyDevices([]);
        setStatus(STATES.DISCOVERING);
        console.log('🔍 Searching for nearby hosts...');
        try {
            await NearbyManager.startDiscovery();
        } catch (e) {
            console.error('Discovery error:', e);

            // Check if it's a location services error
            if (e.message && (e.message.includes('LOCATION') || e.message.includes('8034'))) {
                Alert.alert(
                    "Location Required",
                    "Please enable Location/GPS on your device to use Nearby Connections.\n\nGo to: Settings → Location → Turn ON",
                    [
                        { text: "Cancel", style: "cancel" },
                        {
                            text: "Open Settings",
                            onPress: () => {
                                if (Platform.OS === 'android') {
                                    Linking.sendIntent('android.settings.LOCATION_SOURCE_SETTINGS');
                                }
                            }
                        }
                    ]
                );
            } else {
                Alert.alert("Error", "Failed to start discovery: " + (e.message || 'Unknown error'));
            }
            setStatus(STATES.ERROR);
            setErrorMsg("Failed to start discovery");
        }
    };

    const connectToDevice = async (device) => {
        setSelectedDevice(device);
        setStatus(STATES.CONNECTING);
        const deviceName = Device.modelName || 'OffShare Receiver';
        try {
            await NearbyManager.requestConnection(device.id, deviceName);
        } catch (e) {
            console.error(e);
            setStatus(STATES.ERROR);
            setErrorMsg("Failed to request connection");
        }
    };

    const startReceiving = () => {
        // This might be auto-triggered or manually if we want to acknowledge signals.
        // In this flow, Receiving starts passively when sender sends.
        // We just update UI.
        setStatus(STATES.RECEIVING);
    };

    const formatSize = (bytes) => {
        if (!bytes) return '0 B';
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
    };

    const resetFlow = () => {
        NearbyManager.stopAll();
        setStatus(STATES.IDLE);
        setNearbyDevices([]);
        setSelectedDevice(null);
        setIncomingFiles([]);
        setOverallProgress(0);
        setFileProgress({});
    };

    // ─── Render ───────────────────────────────────────────────────
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

            {/* ERROR STATE */}
            {status === STATES.ERROR && (
                <View style={[STYLES.card, styles.centerContent]}>
                    <MaterialCommunityIcons name="alert-circle" size={48} color={COLORS.error} />
                    <Text style={[STYLES.heading, { color: COLORS.error, marginTop: 12 }]}>Error</Text>
                    <Text style={[STYLES.subtitle, { textAlign: 'center', marginVertical: 8 }]}>{errorMsg}</Text>
                    <TouchableOpacity style={styles.primaryButton} onPress={resetFlow}>
                        <Text style={styles.buttonText}>Try Again</Text>
                    </TouchableOpacity>
                </View>
            )}

            {/* 1. IDLE - Find Devices */}
            {status === STATES.IDLE && (
                <View style={[STYLES.card, styles.centerContent, { marginTop: 40 }]}>
                    <View style={styles.iconCircle}>
                        <MaterialCommunityIcons name="radar" size={40} color={COLORS.accent} />
                    </View>
                    <Text style={[STYLES.heading, { marginTop: 24, textAlign: 'center' }]}>
                        Ready to Receive
                    </Text>
                    <Text style={[STYLES.subtitle, { textAlign: 'center', marginBottom: 32 }]}>
                        Ensure the sender is nearby and has started sharing.
                    </Text>

                    <TouchableOpacity
                        style={styles.primaryButton}
                        onPress={startDiscovery}
                    >
                        <MaterialCommunityIcons name="magnify" size={20} color="#FFF" />
                        <Text style={styles.buttonText}>  Find Nearby Devices</Text>
                    </TouchableOpacity>
                </View>
            )}

            {/* 2. DISCOVERING */}
            {status === STATES.DISCOVERING && (
                <View style={[STYLES.card, styles.centerContent, { marginTop: 40 }]}>
                    <Animated.View style={{ transform: [{ scale: pulseAnim }] }}>
                        <MaterialCommunityIcons name="access-point" size={64} color={COLORS.accent} />
                    </Animated.View>
                    <Text style={[STYLES.heading, { marginTop: 32 }]}>Searching...</Text>
                    <Text style={STYLES.subtitle}>Looking for nearby senders</Text>
                </View>
            )}

            {/* 3. DEVICE LIST */}
            {status === STATES.DEVICE_LIST && (
                <View style={[STYLES.card, styles.marginTop]}>
                    <View style={styles.rowBetween}>
                        <Text style={STYLES.heading}>Nearby Devices</Text>
                        <TouchableOpacity onPress={startDiscovery}>
                            <MaterialCommunityIcons name="refresh" size={20} color={COLORS.accent} />
                        </TouchableOpacity>
                    </View>

                    {nearbyDevices.length === 0 ? (
                        <Text style={[STYLES.subtitle, { textAlign: 'center', marginVertical: 20 }]}>
                            No devices found.
                        </Text>
                    ) : (
                        nearbyDevices.map(device => (
                            <TouchableOpacity
                                key={device.id}
                                style={styles.deviceItem}
                                onPress={() => connectToDevice(device)}
                            >
                                <View style={styles.deviceIcon}>
                                    <MaterialCommunityIcons
                                        name={device.type === 'phone' ? 'cellphone' : 'laptop'}
                                        size={24}
                                        color={COLORS.text}
                                    />
                                </View>
                                <View style={styles.deviceInfo}>
                                    <Text style={styles.deviceName}>{device.name}</Text>
                                    <Text style={styles.deviceStatus}>Tap to connect</Text>
                                </View>
                                <MaterialCommunityIcons name="chevron-right" size={24} color={COLORS.textSecondary} />
                            </TouchableOpacity>
                        ))
                    )}
                </View>
            )}

            {/* 4. CONNECTING */}
            {status === STATES.CONNECTING && (
                <View style={[STYLES.card, styles.centerContent, { marginTop: 40 }]}>
                    <ActivityIndicator size="large" color={COLORS.accent} />
                    <Text style={[STYLES.heading, { marginTop: 24 }]}>Connecting...</Text>
                    <Text style={STYLES.subtitle}>
                        Sending request to {selectedDevice?.name || 'Device'}
                    </Text>
                    <Text style={[STYLES.subtitle, { fontSize: 12, marginTop: 4 }]}>
                        Check the sender device to accept the connection.
                    </Text>
                </View>
            )}

            {/* 5. CONNECTED (Show Files) */}
            {status === STATES.CONNECTED && (
                <View>
                    <View style={[STYLES.card, styles.marginTop]}>
                        <View style={styles.rowBetween}>
                            <Text style={STYLES.heading}>Incoming Files</Text>
                            <View style={styles.badge}>
                                <Text style={styles.badgeText}>{incomingFiles.length}</Text>
                            </View>
                        </View>
                        <Text style={styles.filesFromText}>From: {selectedDevice?.name}</Text>

                        <ScrollView style={styles.fileList}>
                            {incomingFiles.map((file, idx) => (
                                <View key={idx} style={styles.fileItem}>
                                    <MaterialCommunityIcons name="file-outline" size={24} color={COLORS.textSecondary} />
                                    <View style={styles.fileInfo}>
                                        <Text style={styles.fileName}>{file.name}</Text>
                                        <Text style={styles.fileSize}>{formatSize(file.size)}</Text>
                                    </View>
                                </View>
                            ))}
                        </ScrollView>
                    </View>

                    {/* Placeholder for waiting for files */}
                    {incomingFiles.length === 0 && (
                        <Text style={[STYLES.subtitle, { textAlign: 'center', marginTop: 20 }]}>Waiting for sender to send files...</Text>
                    )}
                </View>
            )}

            {/* 6. RECEIVING & COMPLETE */}
            {(status === STATES.RECEIVING || status === STATES.COMPLETE) && (
                <View style={[STYLES.card, styles.marginTop]}>
                    <View style={styles.rowBetween}>
                        <Text style={STYLES.heading}>
                            {status === STATES.COMPLETE ? 'Received Successfully' : 'Receiving Files...'}
                        </Text>
                        {status === STATES.COMPLETE && (
                            <MaterialCommunityIcons name="check-circle" size={24} color={COLORS.success} />
                        )}
                    </View>

                    {/* Overall Progress - simplified */}
                    {/* File Progress List */}
                    <ScrollView style={styles.fileList}>
                        {incomingFiles.map((file, idx) => {
                            const progress = fileProgress[file.payloadId] || 0;

                            return (
                                <View key={idx} style={styles.fileProgressRow}>
                                    <View style={{ flex: 1 }}>
                                        <Text style={styles.fileProgressName} numberOfLines={1}>{file.name}</Text>
                                        <View style={styles.miniProgressBg}>
                                            <View style={[
                                                styles.miniProgressFill,
                                                { width: `${progress}%` },
                                                progress >= 100 && { backgroundColor: COLORS.success }
                                            ]} />
                                        </View>
                                    </View>
                                    <Text style={styles.fileProgressPercent}>
                                        {Math.round(progress)}%
                                    </Text>
                                </View>
                            );
                        })}
                    </ScrollView>

                    {status === STATES.COMPLETE && (
                        <TouchableOpacity
                            style={[styles.primaryButton, { marginTop: 24, backgroundColor: COLORS.surface }]}
                            onPress={resetFlow}
                        >
                            <Text style={styles.buttonText}>Done</Text>
                        </TouchableOpacity>
                    )}
                </View>
            )}

            <View style={{ height: 40 }} />
        </ScrollView>
    );
};

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
    marginTop: {
        marginTop: 16,
    },
    centerContent: {
        alignItems: 'center',
        paddingVertical: 40,
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
        paddingHorizontal: 24,
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
    iconCircle: {
        width: 80,
        height: 80,
        borderRadius: 40,
        backgroundColor: COLORS.surfaceHighlight,
        alignItems: 'center',
        justifyContent: 'center',
    },
    deviceItem: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: COLORS.surfaceHighlight,
        padding: 16,
        borderRadius: 10,
        marginBottom: 10,
    },
    deviceIcon: {
        width: 40,
        height: 40,
        borderRadius: 20,
        backgroundColor: COLORS.background,
        alignItems: 'center',
        justifyContent: 'center',
        marginRight: 12,
    },
    deviceInfo: {
        flex: 1,
    },
    deviceName: {
        color: COLORS.text,
        fontSize: 16,
        fontWeight: '600',
    },
    deviceStatus: {
        color: COLORS.textSecondary,
        fontSize: 12,
    },
    filesFromText: {
        color: COLORS.textSecondary,
        fontSize: 14,
        marginBottom: 16,
    },
    fileList: {
        maxHeight: 250,
    },
    fileItem: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: COLORS.surfaceHighlight, // Slightly lighter than card bg
        padding: 10,
        borderRadius: 8,
        marginBottom: 8,
    },
    fileInfo: {
        marginLeft: 12,
        flex: 1,
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
    badge: {
        backgroundColor: COLORS.accent,
        paddingHorizontal: 8,
        paddingVertical: 2,
        borderRadius: 10,
    },
    badgeText: {
        color: '#FFF',
        fontSize: 12,
        fontWeight: 'bold',
    },
    progressBarBg: {
        height: 8,
        backgroundColor: COLORS.surfaceHighlight,
        borderRadius: 4,
        overflow: 'hidden',
        marginBottom: 4,
    },
    progressBarFill: {
        height: '100%',
        backgroundColor: COLORS.accent,
    },
    fileProgressRow: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: 12,
    },
    fileProgressName: {
        color: COLORS.text,
        fontSize: 13,
        marginBottom: 4,
    },
    miniProgressBg: {
        height: 4,
        backgroundColor: COLORS.surfaceHighlight,
        borderRadius: 2,
        overflow: 'hidden',
    },
    miniProgressFill: {
        height: '100%',
        backgroundColor: COLORS.accent,
    },
    fileProgressPercent: {
        color: COLORS.textSecondary,
        fontSize: 12,
        marginLeft: 12,
        width: 35,
        textAlign: 'right',
    },
});

export default ReceiveScreen;
