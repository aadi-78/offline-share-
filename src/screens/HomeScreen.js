
import React from 'react';
import { StyleSheet, Text, View, TouchableOpacity, Dimensions } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { COLORS, STYLES } from '../constants/theme';

const { width } = Dimensions.get('window');

const HomeScreen = ({ onSelectRole }) => {
    return (
        <View style={styles.container}>
            <View style={styles.header}>
                <MaterialCommunityIcons name="flash" size={32} color={COLORS.accent} />
                <Text style={styles.appName}>OffShare</Text>
            </View>

            <View style={styles.cardContainer}>
                <TouchableOpacity
                    style={styles.card}
                    onPress={() => onSelectRole('share')}
                    activeOpacity={0.8}
                >
                    <View style={styles.iconContainer}>
                        <MaterialCommunityIcons name="upload-network" size={40} color={COLORS.accent} />
                    </View>
                    <Text style={STYLES.title}>Share Files</Text>
                    <Text style={STYLES.subtitle}>Start hotspot and send files directly</Text>
                </TouchableOpacity>

                <TouchableOpacity
                    style={styles.card}
                    onPress={() => onSelectRole('receive')}
                    activeOpacity={0.8}
                >
                    <View style={styles.iconContainer}>
                        <MaterialCommunityIcons name="radar" size={40} color={COLORS.accent} />
                    </View>
                    <Text style={STYLES.title}>Receive Files</Text>
                    <Text style={STYLES.subtitle}>Connect to a sender nearby</Text>
                </TouchableOpacity>
            </View>
        </View>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: COLORS.background,
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        position: 'absolute',
        top: 60,
    },
    appName: {
        fontSize: 28,
        fontWeight: 'bold',
        color: COLORS.text,
        marginLeft: 10,
        letterSpacing: 1.5,
    },
    cardContainer: {
        width: '100%',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 20,
    },
    card: {
        ...STYLES.card,
        width: '100%',
        height: 180,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1,
        borderColor: '#30363D',
    },
    iconContainer: {
        padding: 15,
        borderRadius: 50,
        backgroundColor: '#0D1117',
        marginBottom: 16,
        borderWidth: 1,
        borderColor: COLORS.accent + '40', // 40% opacity
    },
});

export default HomeScreen;
