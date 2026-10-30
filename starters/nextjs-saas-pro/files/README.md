# {{appTitle}}

A Next.js App Router dashboard with sign-in: server actions for login and profile, the API token in an HttpOnly cookie, middleware that protects private pages, a sidebar layout, and loading and error states.

```bash
cp .env.example .env.local   # API_URL
npm run dev
```

Your API needs three endpoints (change the paths in `lib/api/auth.ts`):

- `POST /auth/login` with `{ email, password }` → `{ token }`
- `GET /auth/me` with `Authorization: Bearer <token>` → `{ id, name, email }`
- `PATCH /auth/me` with `{ name }`

Then build on it with codz:

```bash
codz init
codz api add                              # paste a cURL command
codz screen add orders --api getOrders    # a page under app/
```

`codz screen add` writes the page to `app/orders/`. Move that folder into `app/(app)/` to show it inside the dashboard layout, behind sign-in, and add it to `matcher` in `middleware.ts` and to the links in `components/Sidebar.tsx`.

- `lib/api/client.ts` `apiFetch<T>()` for server components and actions; it sends the signed-in user's token
- `lib/auth/` the session cookie and the server actions
- `app/(app)/` pages behind sign-in, `app/(auth)/` the sign-in page
