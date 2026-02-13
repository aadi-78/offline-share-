
import React, { useState } from 'react';
import { StyleSheet, View, StatusBar as RNStatusBar } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import HomeScreen from './src/screens/HomeScreen';
import ShareScreen from './src/screens/ShareScreen';
import ReceiveScreen from './src/screens/ReceiveScreen';
import { COLORS } from './src/constants/theme';

export default function App() {
  const [currentScreen, setCurrentScreen] = useState('home'); // home, share, receive

  const renderScreen = () => {
    switch (currentScreen) {
      case 'share':
        return <ShareScreen onBack={() => setCurrentScreen('home')} />;
      case 'receive':
        return <ReceiveScreen onBack={() => setCurrentScreen('home')} />;
      case 'home':
      default:
        return <HomeScreen onSelectRole={(role) => setCurrentScreen(role)} />;
    }
  };

  return (
    <View style={styles.container}>
      <StatusBar style="light" backgroundColor={COLORS.background} />
      {renderScreen()}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
});
