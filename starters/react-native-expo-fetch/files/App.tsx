import { NavigationContainer } from '@react-navigation/native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import RootNavigator from './src/navigation/RootNavigator';
import { useTheme } from './src/theme/useTheme';

export default function App() {
  const theme = useTheme();
  return (
    <SafeAreaProvider>
      <NavigationContainer theme={theme.navigation}>
        <RootNavigator />
        <StatusBar style={theme.dark ? 'light' : 'dark'} />
      </NavigationContainer>
    </SafeAreaProvider>
  );
}
