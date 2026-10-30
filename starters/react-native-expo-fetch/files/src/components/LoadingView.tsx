import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { useTheme } from '../theme/useTheme';

export default function LoadingView() {
  const { colors } = useTheme();
  return (
    <View style={styles.center}>
      <ActivityIndicator color={colors.primary} />
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
