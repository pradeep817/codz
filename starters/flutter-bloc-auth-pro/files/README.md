# {{appTitle}}

A Flutter app with sign-in: flutter_bloc, Dio with an interceptor that sends the token and refreshes it on a 401, tokens in secure storage, go_router that keeps signed-out users on the login page, bottom navigation, and a settings page with a remembered light/dark choice.

```bash
flutter run --dart-define=API_BASE_URL={{apiBaseUrl}}
flutter test
```

Your API needs (change the paths in `lib/data/repositories/auth_repository.dart`):

- `POST /auth/login` with `{ email, password }` → `{ token, refreshToken?, user: { id, name, email } }`
- `GET /auth/me` → `{ id, name, email }`
- `POST /auth/refresh` with `{ refreshToken }` → `{ token, refreshToken? }` (optional; without it a 401 signs out)

Add an endpoint with `devtool api add` and a screen with `devtool screen add`.
