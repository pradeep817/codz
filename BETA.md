# codz beta: quick start

Thanks for trying codz. It writes the repetitive parts of an app that talks to an API (models, API functions, screens, routes, tests, sign-in) in the style your project already uses. Every change is shown as a diff first, and `codz undo` takes it back.

This is a beta. It will get some things wrong, and that is exactly what we want to hear about.

## 1. Install (2 minutes)

You need Node.js 20 or newer (22 recommended) and git.

```bash
npm install -g codz-cli              # the command is `codz`
codz --version
codz doctor --setup                  # checks Node, git, your formatter and analyzer
```

## 2. Before you start

- **Work on a branch.** `git switch -c try-codz`. codz refuses to write over uncommitted changes unless you pass `--allow-dirty`.
- **Nothing is written until you say yes.** Every command shows the diff and asks. `--dry-run` only shows it.
- **Undo is always there.** `codz undo` restores the files from codz's own backups, even without git. `codz history` lists what was applied.
- **No network, no telemetry.** codz works on your files only. It keeps a small log of which commands ran in `.codz/` so you can send us a report (step 6); nothing is sent by itself.

## 3. The first 10 minutes

In your app's folder:

```bash
codz init                                       # detects the framework and conventions
codz explain                                    # what codz understood about the project
codz feature add products --spec "$(npm root -g)/codz-cli/examples/openapi.yaml"
```

`feature add` adds the endpoints, a list, detail, create and edit screen, links them and writes tests, as one change. If your project has no API layer yet, it sets one up first in your framework's usual style (choose another with `--architecture`).

Run the app and look at the new screens. Then take it all back:

```bash
codz undo
```

## 4. Then try it on your own API

| Try | Command |
| --- | --- |
| A whole feature from your OpenAPI / Swagger / Postman file | `codz feature add orders --spec your-api.yaml` |
| One endpoint from a cURL command | `codz api add` and paste the cURL (and a response sample) |
| One more screen | `codz screen add order-details --api getOrder --path /orders/:id` |
| Sign-in | `codz auth add` |
| Keep up with API changes | `codz api sync your-api.yaml --check` |
| What changed between two spec versions, and where you use it | `codz api diff old.yaml new.yaml` |
| Find problems | `codz doctor` |

`codz help <command>` explains any command and its options.

## 5. What is ready, and what is new

| Platform | Status |
| --- | --- |
| Next.js (App Router) | Stable |
| React Native (Expo or CLI; React Navigation or Expo Router) | Stable |
| Flutter (Riverpod, Bloc, get_it, GetX) | Stable |
| Android with Jetpack Compose (Hilt, Koin or none) | Stable |
| React web apps (Vite or Create React App) | Experimental |
| Android with XML layouts (Activities) | Experimental |
| iOS with SwiftUI | Experimental |

Known gaps: forms for nested data (an order with line items) are skipped; iOS has no `test add`, `mock add` or `auth add`; UIKit and Fragments are not supported.

## 6. Tell us how it went

After a few days of use, in each project you tried it on:

```bash
codz report
```

It prints counts only: commands run, changes applied and undone, errors, and your setup (framework, HTTP client, router). No code, file names, endpoint paths or URLs. Paste it into the feedback form with your answers to:

1. What did you use codz for?
2. Roughly how much time did it save you (or cost you)?
3. What did it get wrong, or what did you have to fix by hand?
4. Would you keep using it? Why or why not?
5. What is the one thing it should do next?

## When something goes wrong

- Read the message and the line under it: it says what happened and what to do.
- `codz undo` puts the files back. If you edited them since, it asks before overwriting (`--force`).
- For a crash ("This is a codz bug"), run the command again with `CODZ_DEBUG=1` and send us the output.
- `CODZ_NO_EVENTS=1` stops codz from logging which commands ran.
