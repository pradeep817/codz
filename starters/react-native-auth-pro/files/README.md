# {{appTitle}}

An Expo app with sign-in: the token in the Keychain/Keystore (expo-secure-store), axios that sends it on every request and signs out on a 401, React Query with sensible retries, a login screen, bottom tabs and a profile screen with sign out.

```bash
cp .env.example .env      # set EXPO_PUBLIC_API_URL
npx expo install --fix    # match native packages to your Expo SDK
npm start
```

Your API needs (change the paths in `src/api/auth.ts`):

- `POST /auth/login` with `{ email, password }` → `{ token, user: { id, name, email } }`
- `GET /auth/me` → `{ id, name, email }`
- `POST /auth/logout` (optional)

Add an endpoint with `codz api add`: it writes the axios function in `src/api/` and a React Query hook in `src/hooks/`. Add a screen with `codz screen add`.
