import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useTheme } from '../theme/useTheme';

interface Props {
  message: string;
  onRetry?: () => void;
}

/** A full-screen error with a retry button. */
export default function ErrorView({ message, onRetry }: Props) {
  const { colors } = useTheme();
  return (
    <View style={styles.center}>
      <Text style={[styles.message, { color: colors.text }]}>{message}</Text>
      {onRetry ? (
        <Pressable accessibilityRole="button" onPress={onRetry} style={[styles.button, { backgroundColor: colors.primary }]}>
          <Text style={styles.buttonText}>Try again</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 16 },
  message: { fontSize: 16, textAlign: 'center' },
  button: { paddingHorizontal: 20, paddingVertical: 10, borderRadius: 8 },
  buttonText: { color: '#FFFFFF', fontWeight: '600' },
});
