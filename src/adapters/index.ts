import { loadConfig } from '../core/config.ts';
import type { Adapter, FrameworkId } from '../core/types.ts';
import { detectAt } from '../detector.ts';
import { flutterAdapter } from './flutter.ts';
import { genericAdapter } from './generic.ts';
import { nextjsAdapter } from './nextjs.ts';
import { reactNativeAdapter } from './reactNative.ts';
import { androidAdapter } from './android.ts';
import { reactAdapter } from './react.ts';
import { iosAdapter } from './ios.ts';

export const ADAPTERS: Record<FrameworkId, Adapter> = {
  nextjs: nextjsAdapter,
  flutter: flutterAdapter,
  'react-native': reactNativeAdapter,
  react: reactAdapter,
  ios: iosAdapter,
  android: androidAdapter,
  generic: genericAdapter,
};

/** Picks the adapter: the framework in codz.config.yaml wins, then detection. */
export function adapterFor(root: string): { adapter: Adapter; label: string } {
  const cfg = loadConfig(root);
  if (cfg.framework && ADAPTERS[cfg.framework]) return { adapter: ADAPTERS[cfg.framework], label: cfg.framework };
  const d = detectAt(root);
  if (d?.supported) return { adapter: ADAPTERS[d.framework], label: d.label };
  return { adapter: genericAdapter, label: d?.label ?? 'unknown' };
}
