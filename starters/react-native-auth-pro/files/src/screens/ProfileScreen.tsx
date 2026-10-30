import { StyleSheet, Text, View } from 'react-native';

import { useAuth } from '../auth/AuthContext';
import { useMe } from '../hooks/use-me';
import Button from '../components/Button';
import { useTheme } from '../theme/useTheme';

export default function ProfileScreen() {
  const { user: signedIn, signOut } = useAuth();
  // Fresh from the API when this tab opens; the sign-in copy shows meanwhile.
  const { data: user = signedIn } = useMe();
  const { colors } = useTheme();
  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <Text style={[styles.name, { color: colors.text }]}>{user?.name}</Text>
        <Text style={{ color: colors.muted }}>{user?.email}</Text>
      </View>
      <Button title="Sign out" variant="secondary" onPress={signOut} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 24, gap: 16 },
  card: { borderWidth: 1, borderRadius: 12, padding: 16, gap: 4 },
  name: { fontSize: 18, fontWeight: '700' },
});
