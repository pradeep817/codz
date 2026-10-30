# Starter templates (internal)

Source folders for the starters `codz new` installs. Each has `manifest.json`,
`LICENSE` and `files/`. After editing files, refresh the hashes and run the gates:

```bash
node scripts/starters.ts files starters/flutter-riverpod-dio
node scripts/starters.ts check starters/*/
node scripts/starters.ts pack starters/flutter-riverpod-dio ../registry   # then: index ../registry --key <pem> [--timestamp-key <online.pub>]
```

| Starter | Framework | Tier in the demo catalog |
| --- | --- | --- |
| `flutter-riverpod-dio` | Flutter | free |
| `nextjs-app-router-fetch` | Next.js | free |
| `react-native-expo-fetch` | React Native (Expo) | free |
| `android-compose-hilt` | Android (Kotlin, Compose) | free |
| `nextjs-saas-pro` | Next.js, sign-in dashboard | paid |
| `flutter-bloc-auth-pro` | Flutter, sign-in with bloc and token refresh | paid |
| `react-native-auth-pro` | React Native (Expo), sign-in and tabs | paid |

Free or paid is decided in the registry's `catalog.json`, not here. Each starter passes `check`, and `codz init` on a new project finds the conventions in its manifest's `expectedConventions`, so `codz api add` and `screen add` work right away.

Try one locally without the catalog: `codz new my_app --template ./starters/flutter-riverpod-dio`.
