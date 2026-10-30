# {{appTitle}}

Created with `codz new --template nextjs-app-router-fetch`: Next.js App Router, TypeScript and a typed fetch helper.

```bash
cp .env.example .env.local
npm run dev
codz init                      # once: detect the conventions
codz api add                   # paste a cURL command
codz screen add <name> --api <endpoint>
```

- `lib/api/` `apiFetch<T>()` and the API functions codz writes
- `types/` response models
- `app/` pages, with `error.tsx` and `not-found.tsx`
