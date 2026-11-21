# About this fork

A personal fork of [mega-yfue/ha-eufy-sdk-bridge](https://github.com/mega-yfue/ha-eufy-sdk-bridge), run as a Docker
image beside one Home Assistant install with eufy cameras behind a HomeBase 3 (T8030) with a drive fitted. Its `main`
is upstream's `dev` branch plus the changes listed below, on the library from
[oliviacpu/eufy-sdk](https://github.com/oliviacpu/eufy-sdk) (upstream's newest beta plus that fork's changes).
Upstream's README, `CONTRIBUTING.md` and `docs/` still apply.

## Rules for changes

- **Nothing is sent upstream.** Changes still stay upstream-shaped: one change and its tests per commit, so any one of
  them could be cherry-picked onto an upstream branch later.
- **Upstream behaviour stays the default.** A new setting does nothing until it's set; existing endpoints, events and
  settings behave as upstream's do.
- **Work happens on `fork/*` branches**, merged into `main` by pull request in this repository.
- **Tests:** Node 24, `npm ci`, `npm run lint`, `node --check` on every `.mjs`, `npm test`.

## Upstream, images and installs

- **Upstream sync:** `.github/workflows/fork-sync.yml` runs daily at 09:17 UTC, an hour after the library fork's. It
  merges upstream's `dev` into `main` when `main` doesn't have it yet, moves `@mega-yfue/eufy-sdk` to the library fork's
  newest release when there's a newer one, runs the checks above, pushes, and builds an image. A merge that conflicts,
  fails the checks, or changes upstream's workflow files (which the workflow's token may not push) opens or updates
  one issue labelled `upstream-sync`; nothing is pushed. Merge by hand then: `git fetch upstream`, branch from `main`,
  `git merge upstream/dev`, fix, open a pull request here, merge, and run `fork-image.yml`.
- **Image:** `.github/workflows/fork-image.yml`, run by the sync or by hand. It runs the checks, builds linux/amd64,
  pushes `ghcr.io/oliviacpu/ha-eufy-sdk-bridge:oliviacpu-YYYY.MM.DD[.N]` and moves `:latest` to it, tags `main` with
  the same name, and creates a GitHub Release listing the fork changes. Upstream's tags are bare versions, so the two
  never collide.
- **Deploy:** by hand. The install pins the image by digest; after a release, replace the digest and redeploy.
  Nothing deploys itself.
- **Library:** `package.json` takes `@mega-yfue/eufy-sdk` from a library fork release asset by URL, so the package
  name and imports don't change.
- **Upstream's workflows are disabled here** except `ci.yml`: `publish-ghcr.yml` and `publish-dev.yml` publish
  upstream's image, and `guard-release-branch.yml` polices upstream's own pull requests. After a manual upstream merge,
  check `gh workflow list --all` for new ones.

## Changes in this fork

Newest first.

### HomeBase 3 recordings for `/clip`, and a clip archive (2026-11-21)

- **What it adds:** `/clip/<sn>` works for a camera behind a HomeBase 3. `CLIP_ARCHIVE_DIR` (off unless set) keeps
  every recording the cameras' HomeBases hold as `<camera name>/<yyyy>/<MM>/<dd>/<HH-mm-ss>.mp4` with the event's
  cover beside it as `.jpg`, once each; `CLIP_ARCHIVE_SWEEP_MS` (default 30 min) sets how often it catches up.
- **Cause:** `/clip` learns the recording from the push (`payload.p`), and a HomeBase 3's push names none, so it
  always answered 409. The H.265 such a station records was muxed as H.264.
- **Change:** without a push, `/clip` takes the newest recording the station's `history_record_info` table names and
  downloads it at the row's `storage_path` (the library fork's `storagePath`), which reaches a drive fitted to the
  station. `muxMp4` reads H.265 as `hevc`, tags it `hvc1` (what Safari and Apple's players need) and puts the frame
  rate in `-r`. The archive (`src/clip-archive.mjs`) runs after each detection (45 s, 2 min, 5 min), at startup and on
  the sweep; `.index.json` keys saved files by station and record id, and a download that fails or comes back short of
  the row's frame count is left for the next pass. `warmup.mjs` exposes `recordingRows` and `recordingCover` on the
  locked history read the cover refresh already uses. Docs: `README.md`, `docs/ws-protocol.md`,
  `docs/docker-compose.md`. Tests: `test/clip-hb3.test.mjs`, `test/clip-archive.test.mjs`.
- **Live (T8030 with a 500 GB SSD, 2026-11-21):** the station streamed a T8170's and a T8213's recordings in full
  from `/zx/hdd_data1/…` in about 3 s each. Muxed as `hvc1` and as `hev1`, both played in Chrome with no dropped or
  corrupted frames.
