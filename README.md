# BBF Code

BBF Code is the Blackbox Factories code editor: a branded distribution of the
[Code - OSS](https://github.com/microsoft/vscode) editor with our own identity,
extension feed, themes, and sign-in.

## What is different from upstream

- **Branding** — product name, icons, splash, title bar, themes (`BBF Dark` is
  the default, `BBF Light` ships alongside it) and installer.
- **Extension feed** — the marketplace is served by our own gallery proxy, which
  forwards public extensions to [Open VSX](https://open-vsx.org) and serves BBF
  extensions from an authenticated GitHub Releases feed. See [`server/`](server/).
- **BBF Proprietary Extensions** — a dedicated section in the Extensions view fed
  by that server.
- **Sign-in** — the workbench is gated behind a Google account on the
  `blackboxfactories.com` domain.
- **Telemetry** — Microsoft telemetry, crash reporting, and AppInsights are
  disabled at the source.

## Building and running

```
npm install
npm run compile          # or `npm run transpile-client` for a fast pass
scripts\code.bat         # Windows
./scripts/code.sh        # macOS and Linux
```

Target platforms are Windows x64, macOS (Intel and Apple Silicon), and Linux x64.

Engineering guidelines, instructions, and skills live in [`.agents/`](.agents/).

## Licensing

BBF Code is derived from Code - OSS, which is distributed under the MIT license.
That license and its copyright notice are retained in [LICENSE.txt](LICENSE.txt),
and the notices for bundled third-party components are retained in
[ThirdPartyNotices.txt](ThirdPartyNotices.txt). Both must ship with the product:
the MIT grant is conditional on the notice travelling with the software.
