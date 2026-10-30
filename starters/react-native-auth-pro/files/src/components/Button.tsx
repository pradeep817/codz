import { ActivityIndicator, Pressable, StyleSheet, Text } from 'react-native';

import { useTheme } from '../theme/useTheme';

interface Props {
  title: string;
  onPress: () => void;
  loading?: boolean;
  variant?: 'primary' | 'secondary';
}

export default function Button({ title, onPress, loading = false, variant = 'primary' }: Props) {
  const { colors } = useTheme();
  const primary = variant === 'primary';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: loading, busy: loading }}
      disabled={loading}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        primary ? { backgroundColor: colors.primary } : { borderColor: colors.border, borderWidth: 1 },
        { opacity: pressed || loading ? 0.7 : 1 },
      ]}
    >
      {loading ? <ActivityIndicator color={primary ? '#FFFFFF' : colors.text} /> : <Text style={[styles.text, { color: primary ? '#FFFFFF' : colors.text }]}>{title}</Text>}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: { minHeight: 48, borderRadius: 10, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 20 },
  text: { fontSize: 16, fontWeight: '600' },
});
