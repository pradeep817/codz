import { StyleSheet, Text, View } from 'react-native';

import { useTheme } from '../theme/useTheme';

export default function HomeScreen() {
  const { colors } = useTheme();
  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <Text style={[styles.title, { color: colors.text }]}>{'{{appTitle}}'}</Text>
      <Text style={[styles.body, { color: colors.muted }]}>
        Add your first endpoint with devtool api add, then a screen with devtool screen add.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 8 },
  title: { fontSize: 22, fontWeight: '700' },
  body: { fontSize: 15, textAlign: 'center' },
});
