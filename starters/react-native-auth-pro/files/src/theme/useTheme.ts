import { DarkTheme, DefaultTheme, type Theme } from '@react-navigation/native';
import { useColorScheme } from 'react-native';

import { palette } from './colors';

export interface AppTheme {
  dark: boolean;
  colors: typeof palette.light & { primary: string };
  navigation: Theme;
}

/** The light or dark theme, following the phone's setting. */
export function useTheme(): AppTheme {
  const dark = useColorScheme() === 'dark';
  const c = dark ? palette.dark : palette.light;
  const base = dark ? DarkTheme : DefaultTheme;
  return {
    dark,
    colors: { ...c, primary: palette.primary },
    navigation: { ...base, colors: { ...base.colors, primary: palette.primary, background: c.background, card: c.card, text: c.text, border: c.border } },
  };
}
