# Bundle baseline manifest

`src/index.html` is a generated artifact: it is rebuilt from the vendored sources
in `web/` by `web/bundle.js`. This file records the baseline the build must
reproduce and every intentional deviation from `upstream/main:web/`.

## Baseline

- Shipped bundle (pre-vendoring `src/index.html`, preserved at
  `.omo/evidence/task-1-baseline-index.html`):
  sha256 `f387723cdb8b3eb2774db297b40f13a582e08344874c5af4956e03d163f7e053`
- A rebuild must be **byte-identical** to that file. The allowed-diff manifest
  is therefore EMPTY: any `diff` output is a regression.

## How to rebuild

```sh
devenv shell -- npm run build:ui
# equivalently: cd web && npm install && node bundle.js index.html ../src/index.html
```

`tauri.conf.json` runs the same command via `build.beforeBuildCommand` /
`build.beforeDevCommand`.

## Vendored React versions

React/ReactDOM UMD production builds are committed under `web/vendor/` and
inlined from disk — the build performs NO network requests for them.

| File | Version | sha256 |
| --- | --- | --- |
| `vendor/react.production.min.js` | react@18.3.1 (umd) | `d949f1c3687aedadcedac85261865f29b17cd273997e7f6b2bfc53b2f9d4c4dd` |
| `vendor/react-dom.production.min.js` | react-dom@18.3.1 (umd) | `35f4f974f4b2bcd44da73963347f8952e341f83909e4498227d4e26b98f66f0d` |

JSX is pre-compiled with `@babel/core`/`@babel/preset-react` pinned by
`web/package-lock.json` (@babel/core 7.29.0). If the lockfile is regenerated
with a newer babel, compiled-JS output may drift; re-diff against the baseline
sha above before accepting it.

## Intentional deviations from upstream/main:web/ (required for byte-equality)

1. **`index.html`**: the three Google-Fonts `<link>` lines (upstream lines 8–10:
   preconnect to fonts.googleapis.com / fonts.gstatic.com + the stylesheet)
   are removed — the app is fully offline and the shipped baseline contains no
   font links.
2. **`styles.css`**: `--font-sans` / `--font-mono` (upstream lines 32–33) drop
   the Google-Fonts families (`"Inter"`, `"JetBrains Mono"`) in favor of the
   system stacks used by the shipped bundle. Without this the rebuild differs
   from the baseline by exactly those two lines.
3. **`bundle.js`** hard-fails instead of degrading (see below) and additionally
   strips the `src` attribute from inlined local `<script>` tags — the shipped
   baseline has zero `<script src=`, `<script type="text/babel">` (outside the
   commented data.jsx block), `integrity=`, or `crossorigin=` occurrences, and
   keeping `src` on an inlined script would make browsers ignore its content.
4. **`filter-panel.jsx`** is vendored in addition to the 13 files listed in the
   work plan: `index.html` loads it and the shipped baseline contains the
   compiled `FilterPanel` component.
5. `web/` sources are otherwise byte-for-byte `upstream/main:web/*` (verified
   at vendor time, 2026-09-16).

## Hard-fail guarantees in `bundle.js`

- `@babel/core` / `@babel/preset-react` missing → exit 1 (never emits raw JSX).
- Any JSX compile error → exit 1.
- Any missing local dependency (jsx/css/vendor file) → exit 1.
- Output still containing `unpkg.com` or `cdn.jsdelivr` after bundling → exit 1
  (the `reactjs.org` error-decoder URL inside react-dom.production.min.js is
  allowed). Scan runs before the output file is written, so a failing build
  never overwrites a good `src/index.html`.
- No dev-CDN fallback branch exists: a missing `web/vendor/` file is fatal.

## Sabotage results (2026-09-16, dev shell with network)

| Scenario | Result |
| --- | --- |
| `mv web/node_modules …` + `node bundle.js` (no install) | exit 1 — "@babel/core … not available — Refusing to emit uncompiled JSX" |
| offline + cold-cache `npm install` (`npm_config_offline=true`, empty cache) | exit 1 — ENOTCACHED (the environment `mv node_modules → build:ui` assumes) |
| missing `web/vendor/react.production.min.js` | exit 1 — "missing local dependency: vendor/react.production.min.js" |
| `mv web/node_modules …` + `npm run build:ui` **with network + warm npm cache** | exit 0 — npm legitimately reinstalls deps, JSX compiles, output passes the CDN scan (no degradation occurs; this is correct behavior, not a silent fallback) |

## Invariants (check after any bundle change)

```sh
npm run build:ui                                              # exit 0
sha256sum src/index.html   # f387723cdb8b3eb2774db297b40f13a582e08344874c5af4956e03d163f7e053
grep -c unpkg.com src/index.html                              # 0
grep -c cdn.jsdelivr src/index.html                           # 0
grep -c '<script src=' src/index.html                         # 0
```
