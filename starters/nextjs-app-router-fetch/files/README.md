# {{appTitle}}

Created with `devtool new --template nextjs-app-router-fetch`: Next.js App Router, TypeScript and a typed fetch helper.

```bash
cp .env.example .env.local
npm run dev
devtool init                      # once: detect the conventions
devtool api add                   # paste a cURL command
devtool screen add <name> --api <endpoint>
```

- `lib/api/` `apiFetch<T>()` and the API functions devtool writes
- `types/` response models
- `app/` pages, with `error.tsx` and `not-found.tsx`
