# Public video hosting

The two finished videos are public assets of the dedicated GitHub release
`metropolis-videos-2026-10-09`. Publish it with `--latest=false` so it does
not replace the application's latest release. Keep masters, intermediate
renders and private recording data outside the public site and release.

This follows the repository's existing `.gitignore` policy: pitch video
binaries are distributed through GitHub Releases, not tracked in source.
The existing v0.5.1 release already uses this route for the historical
`moneyswitch-pitch-v3-share.mp4`; that older video is not a current demo.

## Manifest contract

Create `site/assets/video/manifest.json` after measuring the actual export
with `ffprobe` and SHA-256. The fields below are required. The names are
examples; replace sizes, hashes and measurements with actual values.

```json
{
  "version": 1,
  "releaseTag": "metropolis-videos-2026-10-09",
  "videos": [
    {
      "id": "technical-demo",
      "filename": "moneyswitch-technical-demo-20261009.mp4",
      "url": "https://github.com/dongsheng123132/moneyswitch/releases/download/metropolis-videos-2026-10-09/moneyswitch-technical-demo-20261009.mp4",
      "sha256": "REPLACE_WITH_ACTUAL_64_CHARACTER_LOWERCASE_SHA256",
      "bytes": 1,
      "durationSeconds": 178,
      "width": 1920,
      "height": 1080
    },
    {
      "id": "team-pitch",
      "filename": "moneyswitch-pitch-20261009.mp4",
      "url": "https://github.com/dongsheng123132/moneyswitch/releases/download/metropolis-videos-2026-10-09/moneyswitch-pitch-20261009.mp4",
      "sha256": "REPLACE_WITH_ACTUAL_64_CHARACTER_LOWERCASE_SHA256",
      "bytes": 1,
      "durationSeconds": 116,
      "width": 1920,
      "height": 1080
    }
  ]
}
```

The script accepts exactly these two IDs. Filenames must be safe lowercase
`.mp4` basenames. URLs must point to the same filename in this repository
and exact release tag, without query strings or fragments. Each file is
limited to 256 MiB. `durationSeconds` must be positive and at most 180 for
the technical demo or 120 for the team pitch; dimensions must be positive
integers no greater than 7680. These metadata checks do not replace probing
the actual exported MP4: the script verifies bytes and hash, not playback
duration or audio/video quality.

## Publish and build

After reviewing the final exports, prepare public release notes and use
the verified source commit as the release target. Commands below are
operator instructions, not a record that upload has happened:

```sh
gh release create metropolis-videos-2026-10-09 \
  --repo dongsheng123132/moneyswitch \
  --target SOURCE_COMMIT_SHA \
  --title "MoneySwitch technical demo and team pitch — 2026-10-09" \
  --notes-file PUBLIC_RELEASE_NOTES.md \
  --latest=false \
  PATH_TO_TECHNICAL_DEMO.mp4 PATH_TO_TEAM_PITCH.mp4

node scripts/fetch-video-assets.mjs
node scripts/fetch-video-assets.mjs --check
```

If the release tag already exists, inspect it first. Do not overwrite an
existing asset without explicitly choosing a new reviewed artifact and
updating its manifest. A private or draft release cannot satisfy the
anonymous Pages download step.

The Pages workflow checks out the source, sets up Node.js 22, runs the
fetch script, then uploads `site/` as its Pages artifact. It runs for site,
fetch-script or workflow changes on `main`, or via `workflow_dispatch`.
No credentials are passed to the fetch script. It requests only public
GitHub assets and permits HTTPS redirects only to GitHub's known asset
hosts. It has a 120-second timeout per asset, a five-redirect limit and
streaming size/hash validation. The job has a ten-minute timeout.

Matching local files are verified and reused. Missing or stale files are
downloaded into temporary files. Downloads are published to the local
artifact directory only after every required asset verifies. A failed
download exits nonzero and prevents the later Pages upload/deploy steps;
the script cleans only temporary files it created. It does not delete
unrelated files or read an authentication token.

## Public playback and acceptance

Once the release and Pages build succeed, each manifest filename is served
at `https://moneyswitch.dev/assets/video/<filename>`. These are target URLs,
not proof of a completed deployment. Official player pages can embed them
with native HTML video controls and offer an MP4 download plus a public
transcript. The page must identify technical demo and team pitch separately.

Prefer the Pages copy for inline playback: the historical Release asset
redirects successfully and supports byte ranges, but responds with
`application/octet-stream` and `Content-Disposition: attachment`.

After publishing, check both direct URLs and player pages without signing in:

```sh
curl --fail --silent --show-error --head --max-time 20 \
  https://moneyswitch.dev/assets/video/moneyswitch-technical-demo-20261009.mp4
curl --fail --silent --show-error --head --max-time 20 \
  --header 'Range: bytes=0-1023' \
  https://moneyswitch.dev/assets/video/moneyswitch-pitch-20261009.mp4
```

Verify HTTP success, `video/mp4`, correct total byte size, byte-range
support, and the uploaded bytes against the manifest hash. Then play both
files in an unauthenticated browser, seek near the end, check audio and
captions, and confirm measured durations remain within the submission limits.
Do not insert unverified target URLs into the submission as completed media.

GitHub Pages currently limits the published site to 1 GB and has a soft
100 GB/month bandwidth limit; the 10-builds/hour soft limit does not apply
to this custom Actions workflow. The two 256 MiB per-file caps leave room
for the current site. Sources: [Pages limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits),
[large-file guidance](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github).

## Separate judge instance: deployment note

The repository's Compose file can run another instance using a new project
name, loopback port, public hostname and data volume. The documented
production project is `moneyswitch`; do not reuse its config, wallet,
volume, administrator token, `deploy/upgrade-us.sh` or
`deploy/activate-caddy.sh` for a judge instance. Those two scripts target
the production deployment and its existing Caddy fragment.

Use a fresh source checkout and a new environment file, with a project such
as `moneyswitch-judges-20261009`, a separately checked available port such as
`4022`, testnet networks only, and a new dedicated hostname. Compose's `-p`
isolates the named volume from `moneyswitch_moneyswitch-data`. Configure a
new Caddy site/fragment separately, validate it and reload with a rollback
copy. No production config or credential needs to be read or copied.

Example commands after the new hostname, directory, nonsecret environment
file and empty legacy password placeholder have been prepared:

```sh
docker compose -p moneyswitch-judges-20261009 --env-file judge.env build server
docker compose -p moneyswitch-judges-20261009 --env-file judge.env up -d server
curl --fail --max-time 5 http://127.0.0.1:4022/healthz
```

The new environment sets a distinct image tag such as
`MONEYSWITCH_IMAGE=moneyswitch-judges:VERIFIED_SOURCE_COMMIT`,
`MONEYSWITCH_LOCAL_PORT=4022`,
`MONEYSWITCH_PUBLIC_URL=https://<new-judge-hostname>`,
`MONEYSWITCH_NETWORKS=eip155:10143,eip155:84532`,
`MONEYSWITCH_DEFAULT_NETWORK=eip155:10143` and a new path for the empty
legacy password placeholder. Initialize a new wallet and use only test
tokens. Judge credentials remain private. A public health check alone
does not prove that a judge can sign in, create a key or complete a payment.
This note is a proposed route; no judge instance was created during the
hosting investigation. See [the deployment guide](../../../deploy/README.zh-CN.md)
and [Compose project isolation](https://docs.docker.com/compose/how-tos/project-name/).
