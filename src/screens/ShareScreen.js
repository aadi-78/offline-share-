import React, { useState, useEffect, useRef } from 'react';
import {
    StyleSheet, Text, View, TouchableOpacity, Alert,
    ScrollView, Animated, BackHandler, NativeModules, NativeEventEmitter, PermissionsAndroid, Platform, Linking
} from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import * as DocumentPicker from 'expo-document-picker';
import { File, Paths, Directory } from 'expo-file-system';
import { COLORS, STYLES } from '../constants/theme';
import * as Device from 'expo-device';

const { NearbyManager } = NativeModules;
const nearbyEvents = new NativeEventEmitter(NearbyManager);

// --- Transfer State Machine ---
const STATES = {
    IDLE: 'idle',
    FILES_SELECTED: 'filesSelected',
    ADVERTISING: 'advertising',
    WAITING_FOR_CONNECTION: 'waitingForConnection',
    CONNECTED: 'connected',
    SENDING: 'sending',
    COMPLETED: 'completed',
    ERROR: 'error',
};

const ShareScreen = ({ onBack }) => {
    const [transferState, setTransferState] = useState(STATES.IDLE);
    const [files, setFiles] = useState([]);
    const [connectedDevice, setConnectedDevice] = useState(null);
    const [connectionRequest, setConnectionRequest] = useState(null);
    const [fileProgress, setFileProgress] = useState({});
    const [overallProgress, setOverallProgress] = useState(0);
    const [errorMsg, setErrorMsg] = useState('');
    const [statusText, setStatusText] = useState('Select files to share');

    // Animations
    const pulseAnim = useRef(new Animated.Value(1)).current;

    // Pulse animation for waiting states
    useEffect(() => {
        if (transferState === STATES.ADVERTISING || transferState === STATES.WAITING_FOR_CONNECTION) {
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
    }, [transferState]);

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
                console.log('Permissions granted:', granted);
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

    const payloadToNameMap = useRef({});
    const completedFilesCount = useRef(0);

    useEffect(() => {
        const subscriptions = [];

        subscriptions.push(nearbyEvents.addListener('onConnectionInitiated', (event) => {
            console.log('Connection Initiated:', event);
            setConnectionRequest({
                id: event.endpointId,
                name: event.endpointName,
                authToken: event.authenticationToken
            });
            setTransferState(STATES.WAITING_FOR_CONNECTION);
            setStatusText(`Connection request from ${event.endpointName}`);
        }));

        subscriptions.push(nearbyEvents.addListener('onConnectionResult', (event) => {
            console.log('Connection Result:', event);
            if (event.status === 'CONNECTED') {
                setTransferState(STATES.CONNECTED);
                setConnectedDevice({ id: event.endpointId, name: 'Receiver' });
                setStatusText('Connected');
            } else if (event.status === 'REJECTED') {
                setTransferState(STATES.IDLE);
                setStatusText('Connection rejected');
                Alert.alert('Connection Rejected', 'The receiver rejected the connection.');
            } else {
                setTransferState(STATES.ERROR);
                setStatusText('Connection failed');
                Alert.alert('Connection Error', 'Failed to connect.');
            }
            setConnectionRequest(null);
        }));

        subscriptions.push(nearbyEvents.addListener('onDisconnected', (event) => {
            console.log('Disconnected:', event);
            setTransferState(STATES.IDLE);
            setConnectedDevice(null);
            setStatusText('Disconnected');
            Alert.alert('Disconnected', 'The connection was lost.');
        }));

        subscriptions.push(nearbyEvents.addListener('onPayloadTransferUpdate', (event) => {
            const fileName = payloadToNameMap.current[event.payloadId];
            if (!fileName) return;

            let percent = 0;
            if (event.totalBytes > 0) {
                percent = (event.bytesTransferred / event.totalBytes) * 100;
            }

            if (event.status === 'SUCCESS' || event.status === 'FAILURE') {
                if (event.status === 'SUCCESS') {
                    percent = 100;
                }
                completedFilesCount.current += 1;
            }

            setFileProgress(prev => ({
                ...prev,
                [fileName]: percent
            }));

            // Calculate overall progress
            setOverallProgress(prev => {
                if (completedFilesCount.current >= files.length && files.length > 0) {
                    return prev;
                }
                return prev;
            });

            if (event.status === 'SUCCESS' || event.status === 'FAILURE') {
                checkCompletion();
            }
        }));

        return () => {
            subscriptions.forEach(sub => sub.remove());
            NearbyManager.stopAll();
        };
    }, []); // Empty dependency array means 'files' is stale inside listeners!

    // Ref to access current files in listener if needed, or better:
    // Move listener setup? No, listener setup should be once.
    // We can use a ref for files.
    const filesRef = useRef(files);
    useEffect(() => {
        filesRef.current = files;
    }, [files]);

    const checkCompletion = () => {
        // We need to know how many files we expected to send.
        // using filesRef
        if (completedFilesCount.current >= filesRef.current.length && filesRef.current.length > 0) {
            setTransferState(STATES.COMPLETED);
            setStatusText('Transfer Completed');
            Alert.alert("Done", "All files sent successfully!");
        }
    };

    // Also calculate overall progress properly
    // We can sum up bytes if we had map of payload -> totalBytes. 
    // For now, simpler: average of percentages? Or just visually rely on individual bars.
    // The UI shows overallProgress. Let's update it.
    useEffect(() => {
        const fileCount = files.length;
        if (fileCount === 0) return;
        const totalPercent = Object.values(fileProgress).reduce((a, b) => a + b, 0);
        setOverallProgress(Math.round(totalPercent / fileCount));
    }, [fileProgress, files]);

    // ─── File Picker ──────────────────────────────────────────────
    const pickFiles = async () => {
        try {
            const result = await DocumentPicker.getDocumentAsync({
                type: '*/*',
                copyToCacheDirectory: true,
                multiple: true,
            });

            const assets = result.assets || (result.type === 'success' ? [result] : []);

            if (assets && assets.length > 0) {
                const processedFiles = assets.map(asset => {
                    let filePath = asset.uri;
                    // Handle file:// URIs
                    if (filePath.startsWith('file://')) {
                        filePath = decodeURIComponent(filePath.replace('file://', ''));
                    }
                    return {
                        name: asset.name,
                        size: asset.size,
                        uri: asset.uri,
                        path: filePath
                    };
                });

                setFiles(prev => [...prev, ...processedFiles]);
                if (transferState === STATES.IDLE) {
                    setTransferState(STATES.FILES_SELECTED);
                    setStatusText('Files selected');
                }
            }
        } catch (err) {
            console.warn('File pick error:', err);
        }
    };

    // ─── Flow Actions ─────────────────────────────────────────────

    const startSharing = async () => {
        if (files.length === 0) {
            Alert.alert('No Files', 'Please select files first.');
            return;
        }

        const hasPermissions = await requestPermissions();
        if (!hasPermissions) {
            Alert.alert('Permission Denied', 'Required permissions not granted.');
            return;
        }

        const deviceName = Device.modelName || 'OffShare Sender';

        try {
            await NearbyManager.startAdvertising(deviceName);
            setTransferState(STATES.ADVERTISING);
            setStatusText('Making device discoverable...');
        } catch (e) {
            console.error('Advertising error:', e);

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
                Alert.alert('Error', 'Failed to start advertising: ' + (e.message || 'Unknown error'));
            }
            setTransferState(STATES.ERROR);
        }
    };

    const acceptConnection = async () => {
        if (!connectionRequest) return;
        try {
            await NearbyManager.acceptConnection(connectionRequest.id);
            // Wait for onConnectionResult
        } catch (e) {
            console.error(e);
            Alert.alert('Error', 'Failed to accept connection.');
        }
    };

    const rejectConnection = async () => {
        if (!connectionRequest) return;
        try {
            await NearbyManager.rejectConnection(connectionRequest.id);
            setConnectionRequest(null);
            setTransferState(STATES.ADVERTISING); // Go back to advertising? Or Idle?
            setStatusText('Waiting for connection request...');
        } catch (e) {
            console.error(e);
        }
    };

    const startSending = async () => {
        if (!connectedDevice) return;

        setTransferState(STATES.SENDING);
        setStatusText('Sending files...');

        // Reset tracking
        completedFilesCount.current = 0;
        payloadToNameMap.current = {};
        setOverallProgress(0);
        setFileProgress({});

        for (const file of files) {
            try {
                // file.path should be absolute path
                const payloadId = await NearbyManager.sendFile(connectedDevice.id, file.path);
                console.log(`Sending ${file.name}, payloadId: ${payloadId}`);

                // Track payload ID for progress updates
                payloadToNameMap.current[payloadId] = file.name;

            } catch (e) {
                console.error(`Failed to send ${file.name}`, e);
                Alert.alert('Send Error', `Failed to send ${file.name}`);
                completedFilesCount.current += 1;
                // Check if all failed immediately?
                if (completedFilesCount.current >= files.length) {
                    setTransferState(STATES.COMPLETED); // Or ERROR?
                    setStatusText('Transfer Finished with Errors');
                }
            }
        }
    };

    // Trigger sending automatically when connected
    useEffect(() => {
        if (transferState === STATES.CONNECTED) {
            setTimeout(() => {
                startSending();
            }, 1000);
        }
    }, [transferState]);

    const stopSharing = () => {
        NearbyManager.stopAll();
        setTransferState(STATES.IDLE);
        setConnectedDevice(null);
        setConnectionRequest(null);
        setOverallProgress(0);
        setFileProgress({});
        setStatusText('Select files to share');

        // Reset refs
        completedFilesCount.current = 0;
        payloadToNameMap.current = {};
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

    const getTotalSize = () => {
        return files.reduce((acc, curr) => acc + (curr.size || 0), 0);
    };

    // ─── Render ───────────────────────────────────────────────────
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

            {/* Status Banner */}
            <View style={[
                styles.statusBanner,
                transferState === STATES.ERROR && styles.statusBannerError,
                transferState === STATES.COMPLETED && styles.statusBannerSuccess
            ]}>
                <MaterialCommunityIcons
                    name={
                        transferState === STATES.ADVERTISING || transferState === STATES.WAITING_FOR_CONNECTION ? "radar" :
                            transferState === STATES.CONNECTED ? "link" :
                                transferState === STATES.SENDING ? "upload" :
                                    transferState === STATES.COMPLETED ? "check" : "information"
                    }
                    size={20}
                    color={transferState === STATES.COMPLETED ? COLORS.success : COLORS.text}
                />
                <Text style={styles.statusText}>{statusText}</Text>
            </View>

            {/* Main Content Area based on State */}

            {/* 1. File Selection */}
            {(transferState === STATES.IDLE || transferState === STATES.FILES_SELECTED) && (
                <View>
                    <View style={[STYLES.card, styles.marginTop]}>
                        <View style={styles.rowBetween}>
                            <Text style={STYLES.heading}>Selected Files ({files.length})</Text>
                            {files.length > 0 && (
                                <TouchableOpacity onPress={() => setFiles([])}>
                                    <Text style={{ color: COLORS.error, fontSize: 13 }}>Clear All</Text>
                                </TouchableOpacity>
                            )}
                        </View>

                        <TouchableOpacity style={styles.outlineButton} onPress={pickFiles}>
                            <MaterialCommunityIcons name="file-plus" size={20} color={COLORS.accent} />
                            <Text style={styles.outlineButtonText}>Choose Files</Text>
                        </TouchableOpacity>

                        {files.map((file, index) => (
                            <View key={index} style={styles.fileItem}>
                                <MaterialCommunityIcons name="file-outline" size={24} color={COLORS.textSecondary} />
                                <View style={styles.fileInfo}>
                                    <Text style={styles.fileName} numberOfLines={1}>{file.name}</Text>
                                    <Text style={styles.fileSize}>{formatSize(file.size)}</Text>
                                </View>
                            </View>
                        ))}
                    </View>

                    {files.length > 0 && (
                        <TouchableOpacity
                            style={[styles.primaryButton, styles.marginTop]}
                            onPress={startSharing}
                        >
                            <MaterialCommunityIcons name="access-point" size={20} color="#FFF" />
                            <Text style={styles.buttonText}>  Start Sharing</Text>
                        </TouchableOpacity>
                    )}
                </View>
            )}

            {/* 2. Advertising & Waiting */}
            {(transferState === STATES.ADVERTISING || transferState === STATES.WAITING_FOR_CONNECTION) && (
                <View style={[STYLES.card, styles.marginTop, styles.centerContent]}>
                    <Animated.View style={{ transform: [{ scale: pulseAnim }] }}>
                        <MaterialCommunityIcons name="broadcast" size={64} color={COLORS.accent} />
                    </Animated.View>
                    <Text style={[STYLES.heading, { marginTop: 24, textAlign: 'center' }]}>
                        {transferState === STATES.ADVERTISING ? 'Making device discoverable...' : 'Waiting for connection...'}
                    </Text>
                    <Text style={[STYLES.subtitle, { textAlign: 'center', marginTop: 8 }]}>
                        {transferState === STATES.ADVERTISING
                            ? 'Waiting for nearby receiver'
                            : 'Other devices can now see "OffShare Sender"'}
                    </Text>

                    {/* Connection Request Card */}
                    {connectionRequest && (
                        <View style={styles.requestCard}>
                            <Text style={styles.requestTitle}>Connection Request</Text>
                            <View style={styles.requestDevice}>
                                <MaterialCommunityIcons name="cellphone" size={24} color={COLORS.text} />
                                <Text style={styles.requestDeviceName}>{connectionRequest.name}</Text>
                            </View>
                            <View style={styles.requestButtons}>
                                <TouchableOpacity
                                    style={[styles.actionButton, { backgroundColor: COLORS.error }]}
                                    onPress={rejectConnection}
                                >
                                    <Text style={styles.actionButtonText}>Reject</Text>
                                </TouchableOpacity>
                                <TouchableOpacity
                                    style={[styles.actionButton, { backgroundColor: COLORS.success }]}
                                    onPress={acceptConnection}
                                >
                                    <Text style={styles.actionButtonText}>Accept</Text>
                                </TouchableOpacity>
                            </View>
                        </View>
                    )}

                    {!connectionRequest && (
                        <TouchableOpacity
                            style={[styles.textButton, { marginTop: 32 }]}
                            onPress={stopSharing}
                        >
                            <Text style={{ color: COLORS.error }}>Cancel</Text>
                        </TouchableOpacity>
                    )}
                </View>
            )}

            {/* 3. Connected & Sending */}
            {(transferState === STATES.CONNECTED || transferState === STATES.SENDING || transferState === STATES.COMPLETED) && (
                <View style={[STYLES.card, styles.marginTop]}>
                    <View style={styles.rowBetween}>
                        <Text style={STYLES.heading}>Connected to</Text>
                        <View style={styles.badge}>
                            <Text style={styles.badgeText}>Nearby</Text>
                        </View>
                    </View>
                    <View style={styles.deviceRow}>
                        <MaterialCommunityIcons name="cellphone-check" size={32} color={COLORS.success} />
                        <Text style={styles.bigDeviceName}>{connectedDevice?.name || 'Receiver'}</Text>
                    </View>

                    <View style={styles.transferSummary}>
                        <View style={styles.summaryItem}>
                            <Text style={styles.summaryLabel}>Files</Text>
                            <Text style={styles.summaryValue}>{files.length}</Text>
                        </View>
                        <View style={styles.summarySeparator} />
                        <View style={styles.summaryItem}>
                            <Text style={styles.summaryLabel}>Total Size</Text>
                            <Text style={styles.summaryValue}>{formatSize(getTotalSize())}</Text>
                        </View>
                    </View>

                    {/* Progress Section */}
                    {(transferState === STATES.SENDING || transferState === STATES.COMPLETED) && (
                        <View style={{ marginTop: 24 }}>
                            <View style={styles.rowBetween}>
                                <Text style={STYLES.heading}>Transfer Progress</Text>
                                <Text style={{ color: COLORS.accent, fontWeight: 'bold' }}>{overallProgress}%</Text>
                            </View>

                            <View style={styles.progressBarBg}>
                                <View style={[styles.progressBarFill, { width: `${overallProgress}%` }]} />
                            </View>

                            <ScrollView style={styles.fileListCompact}>
                                {files.map((file, idx) => (
                                    <View key={idx} style={styles.fileProgressRow}>
                                        <Text style={styles.fileProgressName} numberOfLines={1}>{file.name}</Text>
                                        <Text style={styles.fileProgressPercent}>
                                            {Math.round(fileProgress[file.name] || 0)}%
                                        </Text>
                                    </View>
                                ))}
                            </ScrollView>
                        </View>
                    )}

                    {/* Completed Actions */}
                    {transferState === STATES.COMPLETED && (
                        <View style={{ marginTop: 24 }}>
                            <TouchableOpacity
                                style={styles.primaryButton}
                                onPress={resetTransfer}
                            >
                                <MaterialCommunityIcons name="restart" size={20} color="#FFF" />
                                <Text style={styles.buttonText}>  Send More Files</Text>
                            </TouchableOpacity>
                        </View>
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
    outlineButton: {
        borderWidth: 1,
        borderColor: COLORS.accent + '60',
        borderStyle: 'dashed',
        paddingVertical: 12,
        borderRadius: 8,
        alignItems: 'center',
        marginBottom: 16,
    },
    outlineButtonText: {
        color: COLORS.accent,
        fontSize: 14,
        fontWeight: '600',
    },
    fileItem: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: COLORS.surfaceHighlight,
        padding: 12,
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
    statusBannerError: {
        borderColor: COLORS.error + '50',
        backgroundColor: COLORS.error + '10',
    },
    statusBannerSuccess: {
        borderColor: COLORS.success + '50',
        backgroundColor: COLORS.success + '10',
    },
    statusText: {
        color: COLORS.text,
        fontSize: 14,
        fontWeight: '500',
    },
    requestCard: {
        width: '100%',
        backgroundColor: COLORS.surfaceHighlight,
        padding: 16,
        borderRadius: 12,
        marginTop: 32,
        borderWidth: 1,
        borderColor: COLORS.accent,
    },
    requestTitle: {
        color: COLORS.textSecondary,
        fontSize: 12,
        textTransform: 'uppercase',
        letterSpacing: 1,
        marginBottom: 12,
    },
    requestDevice: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        marginBottom: 20,
    },
    requestDeviceName: {
        color: COLORS.text,
        fontSize: 18,
        fontWeight: 'bold',
    },
    requestButtons: {
        flexDirection: 'row',
        gap: 12,
    },
    actionButton: {
        flex: 1,
        paddingVertical: 12,
        borderRadius: 8,
        alignItems: 'center',
    },
    actionButtonText: {
        color: '#FFF',
        fontWeight: 'bold',
    },
    textButton: {
        padding: 8,
    },
    deviceRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        marginBottom: 24,
    },
    bigDeviceName: {
        color: COLORS.text,
        fontSize: 22,
        fontWeight: 'bold',
    },
    badge: {
        backgroundColor: COLORS.success + '20',
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 4,
    },
    badgeText: {
        color: COLORS.success,
        fontSize: 12,
        fontWeight: 'bold',
    },
    transferSummary: {
        flexDirection: 'row',
        backgroundColor: COLORS.background,
        borderRadius: 8,
        padding: 16,
        alignItems: 'center',
    },
    summaryItem: {
        flex: 1,
        alignItems: 'center',
    },
    summaryLabel: {
        color: COLORS.textSecondary,
        fontSize: 12,
        marginBottom: 4,
    },
    summaryValue: {
        color: COLORS.text,
        fontSize: 16,
        fontWeight: 'bold',
    },
    summarySeparator: {
        width: 1,
        height: '80%',
        backgroundColor: COLORS.border,
    },
    progressBarBg: {
        height: 6,
        backgroundColor: COLORS.surfaceHighlight,
        borderRadius: 3,
        overflow: 'hidden',
        marginTop: 8,
        marginBottom: 16,
    },
    progressBarFill: {
        height: '100%',
        backgroundColor: COLORS.accent,
    },
    fileListCompact: {
        marginTop: 8,
        gap: 12,
        maxHeight: 200,
    },
    fileProgressRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
    },
    fileProgressName: {
        color: COLORS.textSecondary,
        fontSize: 12,
        flex: 1,
        marginRight: 8,
    },
    fileProgressPercent: {
        color: COLORS.text,
        fontSize: 12,
        fontFamily: 'monospace',
    },
});

export default ShareScreen;
