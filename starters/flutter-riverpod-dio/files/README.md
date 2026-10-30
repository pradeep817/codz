# {{appTitle}}

Created with `codz new --template flutter-riverpod-dio`: Flutter with Riverpod, Dio and go_router.

```bash
flutter run --dart-define=API_BASE_URL={{apiBaseUrl}}
codz init                      # once: detect the conventions
codz api add                   # paste a cURL command
codz screen add <name> --api <endpoint>
```

- `lib/app/` app-wide router and theme
- `lib/core/network/` Dio (`dioProvider`) and error messages
- `lib/data/` models and repositories (codz api add writes here)
- `lib/features/` one folder per feature
