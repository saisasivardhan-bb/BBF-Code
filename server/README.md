# BBF Code — Proprietary Extension Feed

Serves BBF's private `.vsix` extensions to BBF Code from **authenticated GitHub
Releases**, and nothing else. Public extensions keep coming from Open VSX; this
feed only ever updates extensions listed in **BBF Proprietary Extensions**.

To publish a new version you attach a `.vsix` to a GitHub release. The server
reads each file's own `extension/package.json`, so there is no second list of
versions to keep in sync.

## Why a server at all

VS Code supports exactly one extension gallery, and BBF Code already points its
gallery at Open VSX. A second gallery is not possible, so BBF extensions travel
over their own channel instead — this one.

The GitHub token stays on the server. BBF Code talks to the server; the server
talks to GitHub. Clients never see repository credentials.

## Setup

```bash
cd server
npm install
cp .env.example .env    # then fill it in
npm start
```

| Variable | Required | Purpose |
|---|---|---|
| `GITHUB_REPO` | yes | `owner/repo` holding the releases |
| `GITHUB_TOKEN` | yes | Fine-grained PAT, **Contents: Read** on that repo |
| `BBF_API_TOKEN` | no | Shared secret clients must send. Without it the feed is open |
| `PUBLIC_URL` | no | Base URL used to build download links (set this behind a proxy) |
| `PORT` | no | Default `4000` |
| `REFRESH_SECONDS` | no | Release metadata cache lifetime, default `300` |
| `LOCAL_VSIX_DIR` | no | Serve `.vsix` from a directory instead of GitHub (dev / air-gapped) |

Point BBF Code at it by adding to `product.json`:

```json
"bbfExtensionsServiceUrl": "https://extensions.blackboxfactories.com"
```

## Publishing an extension

1. Build the `.vsix` (`vsce package`).
2. Create or edit a release in `GITHUB_REPO`.
3. Attach the `.vsix` as a release asset.

Within `REFRESH_SECONDS` it appears in the feed and in BBF Code's **BBF
Proprietary Extensions** section. Version, name, description and icon all come
from inside the `.vsix`.

Notes:
- Draft releases are ignored. Pre-releases are published but flagged, and the
  newest stable version is what the feed offers as current.
- A malformed `.vsix` is skipped and reported under `problems` in the feed and
  on the web page, rather than breaking the whole catalog.

## API

| Endpoint | Purpose |
|---|---|
| `GET /api/health` | Credential and connectivity check |
| `GET /api/extensions` | The catalog BBF Code polls |
| `GET /api/extensions/:id/:version/vsix` | Streams the `.vsix` (token proxied server-side) |
| `GET /api/extensions/:id/:version/icon` | Extension icon, extracted from the `.vsix` |

`GET /` serves a browse UI for the same catalog.

When `BBF_API_TOKEN` is set, send `Authorization: Bearer <token>`. The web page
accepts `?token=…` for convenience; icons are deliberately unauthenticated so
`<img>` tags work.

## Deployment

The process is stateless — its only cache is in memory, so it is safe to
restart or run behind a load balancer. Put it behind TLS: the shared secret and
the `.vsix` bytes both travel over this connection.
