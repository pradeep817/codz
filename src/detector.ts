// Framework detection from signature files. Only frameworks with an adapter
// are "supported"; others are reported by name and handled by the generic adapter.

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { IGNORED_DIRS, isDir, readJson, readText, toPosix } from './core/fsutil.ts';
import type { FrameworkId } from './core/types.ts';

export interface Detection {
  /** Folder relative to the start folder ("." for the start folder itself). */
  root: string;
  framework: FrameworkId;
  /** Human name of what was found, even when no adapter exists (e.g. "React Native"). */
  label: string;
  supported: boolean;
}

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

export function detectAt(dir: string): Omit<Detection, 'root'> | null {
  const pubspec = readText(join(dir, 'pubspec.yaml'));
  if (pubspec !== null) {
    if (/^\s+sdk:\s*flutter\b/m.test(pubspec) || /^flutter:/m.test(pubspec)) return { framework: 'flutter', label: 'Flutter', supported: true };
    return { framework: 'generic', label: 'Dart', supported: false };
  }
  const pkg = readJson<PackageJson>(join(dir, 'package.json'));
  if (pkg) {
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (deps.next) return { framework: 'nextjs', label: 'Next.js', supported: true };
    if (deps['react-native'] || deps.expo) return { framework: 'react-native', label: deps.expo ? 'React Native (Expo)' : 'React Native', supported: true };
    if (deps['@angular/core']) return { framework: 'generic', label: 'Angular', supported: false };
    if (deps.vue || deps.nuxt) return { framework: 'generic', label: 'Vue', supported: false };
    if (deps.react && (deps['react-dom'] || deps.vite || deps['react-scripts'])) return { framework: 'react', label: deps['react-scripts'] ? 'React (Create React App)' : 'React (Vite)', supported: true };
    if (deps.react) return { framework: 'generic', label: 'React', supported: false };
    if (deps.express || deps.fastify || deps['@nestjs/core']) return { framework: 'generic', label: 'Node backend', supported: false };
    return null;
  }
  const pyproject = readText(join(dir, 'pyproject.toml')) ?? readText(join(dir, 'requirements.txt'));
  if (pyproject && /django|fastapi|flask/i.test(pyproject)) return { framework: 'generic', label: 'Python web', supported: false };
  if (readText(join(dir, 'settings.gradle.kts')) !== null || readText(join(dir, 'settings.gradle')) !== null || readText(join(dir, 'build.gradle')) !== null || readText(join(dir, 'build.gradle.kts')) !== null) {
    const app = ['app/build.gradle.kts', 'app/build.gradle'].map((f) => readText(join(dir, f))).find((t) => t !== null);
    if (app && /com\.android\.application|android\.application/.test(app)) return { framework: 'android', label: 'Android (Kotlin)', supported: true };
    return { framework: 'generic', label: 'Android or JVM', supported: false };
  }
  // An Xcode project: an iOS app in Swift.
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    names = [];
  }
  const xcodeproj = names.find((n) => n.endsWith('.xcodeproj'));
  if (xcodeproj && readText(join(dir, xcodeproj, 'project.pbxproj')) !== null) return { framework: 'ios', label: 'iOS (Swift)', supported: true };
  if (readText(join(dir, 'Package.swift')) !== null) return { framework: 'generic', label: 'Swift', supported: false };
  return null;
}

/**
 * Detects the project at `start`, and also looks up to 3 levels down for
 * monorepos. Returns every match; the caller asks which root to use when
 * there is more than one.
 */
export function detect(start: string): Detection[] {
  const found: Detection[] = [];
  const here = detectAt(start);
  if (here && here.supported) return [{ root: '.', ...here }];
  if (here) found.push({ root: '.', ...here });

  const visit = (dir: string, relDir: string, depth: number) => {
    if (depth > 3) return;
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of entries) {
      if (IGNORED_DIRS.has(name) || name.startsWith('.')) continue;
      const abs = join(dir, name);
      if (!isDir(abs)) continue;
      const rel = relDir === '.' ? name : `${relDir}/${name}`;
      const d = detectAt(abs);
      if (d) {
        found.push({ root: toPosix(rel), ...d });
        continue; // Do not look inside a detected project.
      }
      visit(abs, rel, depth + 1);
    }
  };
  visit(start, '.', 1);
  return found;
}
