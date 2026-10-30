import { StyleSheet, Text, View } from 'react-native';

import { useAuth } from '../auth/AuthContext';
import { useTheme } from '../theme/useTheme';

export default function HomeScreen() {
  const { user } = useAuth();
  const { colors } = useTheme();
  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <Text style={[styles.title, { color: colors.text }]}>Hi {user?.name}</Text>
      <Text style={[styles.body, { color: colors.muted }]}>
        Add an endpoint with codz api add: it writes the API function and a React Query hook. Then add a screen with codz screen add.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 8 },
  title: { fontSize: 22, fontWeight: '700' },
  body: { fontSize: 15, textAlign: 'center' },
});
