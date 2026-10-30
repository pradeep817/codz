import axios from 'axios';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet, Text, View } from 'react-native';

import { apiErrorMessage } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import Button from '../components/Button';
import TextField from '../components/TextField';
import { useTheme } from '../theme/useTheme';

export default function LoginScreen() {
  const { signIn } = useAuth();
  const { colors } = useTheme();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!email.trim() || !password) return setError('Enter your email and password.');
    setBusy(true);
    setError(null);
    try {
      await signIn(email.trim(), password);
    } catch (e) {
      setError(axios.isAxiosError(e) && e.response?.status === 401 ? 'That email and password do not match.' : apiErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={[styles.screen, { backgroundColor: colors.background }]}>
      <View style={styles.form}>
        <Text style={[styles.title, { color: colors.text }]}>{'{{appTitle}}'}</Text>
        <TextField label="Email" value={email} onChangeText={setEmail} autoCapitalize="none" autoComplete="email" keyboardType="email-address" textContentType="emailAddress" />
        <TextField label="Password" value={password} onChangeText={setPassword} secureTextEntry autoComplete="current-password" textContentType="password" onSubmitEditing={submit} />
        {error ? <Text style={{ color: colors.danger }} accessibilityLiveRegion="polite">{error}</Text> : null}
        <Button title="Sign in" onPress={submit} loading={busy} />
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, justifyContent: 'center', padding: 24 },
  form: { gap: 16, width: '100%', maxWidth: 420, alignSelf: 'center' },
  title: { fontSize: 28, fontWeight: '700', marginBottom: 8 },
});
