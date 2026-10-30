# devtool for VS Code

Runs [devtool](../../README.md) from the command palette (`devtool: ...`). Every change is shown as a diff first and written only when you click **Apply**; it is saved as a plan either way, so `devtool apply <id>` works from the terminal too.

| Command | What it does |
| --- | --- |
| Add endpoint (cURL or URL) | Takes a cURL command or URL (from the clipboard when it holds one) and an optional response sample, then previews `api add` |
| Sync with API spec | Pick an OpenAPI, Swagger, Postman or HAR file; previews `api sync --add` |
| Show endpoint and its uses | Pick an endpoint, then jump to its declaration or any place that uses it |
| Rename endpoint | Previews `api rename` |
| Mock every endpoint / Write tests for every endpoint | Preview `mock add --all` / `test add --all` |
| Doctor | Findings appear in the Problems panel; "Doctor: fix what is safe" previews `doctor --fix` |
| Explain project | What devtool found, in the devtool output channel |
| Undo last change | `devtool undo` |

Requirements: devtool on `PATH` (`npm link` from a checkout, or the published package once it is on npm), or its full path in the `devtool.path` setting.

Build a package to install: `npx @vscode/vsce package` in this folder, then **Extensions → … → Install from VSIX**.
