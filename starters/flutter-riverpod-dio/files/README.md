# {{appTitle}}

Created with `devtool new --template flutter-riverpod-dio`: Flutter with Riverpod, Dio and go_router.

```bash
flutter run --dart-define=API_BASE_URL={{apiBaseUrl}}
devtool init                      # once: detect the conventions
devtool api add                   # paste a cURL command
devtool screen add <name> --api <endpoint>
```

- `lib/app/` app-wide router and theme
- `lib/core/network/` Dio (`dioProvider`) and error messages
- `lib/data/` models and repositories (devtool api add writes here)
- `lib/features/` one folder per feature
