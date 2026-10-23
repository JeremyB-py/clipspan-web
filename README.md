# ClipSpan website seed

Static site for **clipspan.com**, deployed as a Cloudflare Worker with static assets.

- Public pages: `public/index.html`, `public/privacy.html`
- Shared theme: `public/assets/site.css`
- Google Play badge: set `PLAY_STORE_URL` in [`public/assets/google-play.js`](public/assets/google-play.js) once the listing is public. Until then the home and downloads pages say "coming soon" in plain text, since Google's badge rules don't allow an altered or inactive badge.
- Hero video: `public/assets/launch-video.mp4` is a web encode of `marketing/launch-video/final/clipspan-testing-launch-16x9-v10.mp4` in the ClipSpan repo, and `launch-video-poster.jpg` is that folder's 16:9 thumbnail. To replace it, encode the new master with `ffmpeg -i <master> -c:v libx264 -preset slow -crf 23 -profile:v high -pix_fmt yuv420p -c:a aac -b:a 160k -movflags +faststart public/assets/launch-video.mp4` and bump `?v=` in `index.html`. Static assets ignore `Range`, so the Worker answers byte-range requests for `/assets/*.mp4` and `*.webm` itself. Safari won't play video without them.
- Tester downloads: `public/downloads.html`, gated by per-tester codes in [`src/worker.js`](src/worker.js) (see [Tester codes](#tester-codes))
- Desktop in-app updater: `GET /updates/latest.json` (latest release manifest, cached 5 minutes) and `GET /updates/v<version>/<file>` (AppImage, NSIS `-setup.exe`, or `.msi` only). Both are public without a tester code, because installed apps cannot sign in, and rate limited per IP (30/min for the manifest, 6/min for files; `[[ratelimits]]` in `wrangler.toml`). Integrity comes from the minisign pubkey compiled into the app, not from this Worker. The APK, the `/downloads` listing, and the APT install script stay gated. The APT repo's package lists and `.deb`s are public, as `install.sh` requires.
- Tester APT origin: `https://apt.clipspan.com` (this Worker custom domain; `public/apt/` at URL root). `https://www.clipspan.com/apt` is the same tree. ClipSpan `./scripts/publish-apt-repo.sh --push` replaces `public/apt` (do not edit that tree by hand). Attach `apt.clipspan.com` on Worker **clipspan-web** in the Cloudflare dashboard.
- Pairing QR codes and Android App Links: `GET /.well-known/assetlinks.json` and `/pair` (see [App Links and /pair](#app-links-and-pair)).
- Setup checklist and Reddit notes: [SETUP.md](SETUP.md)

Run the tests (Node's built-in test runner, no dependencies):

```bash
npm test
```

Preview the static pages:

```bash
python3 -m http.server 8080 --directory public
```

Preview downloads auth and the GitHub proxy:

```bash
# .dev.vars in the repo root needs DOWNLOADS_SESSION_KEY and GITHUB_TOKEN
node scripts/tester-codes.mjs add me --local   # a code for the local KV
npx wrangler dev
```

## Cloudflare secrets

Build settings env vars are **not** the Worker bindings. Set runtime secrets on the Worker itself:

1. Workers & Pages → **clipspan-web** → **Settings** → **Variables and Secrets**
2. Add two entries, type **Secret**:
   - `DOWNLOADS_SESSION_KEY`: any long random string (`openssl rand -base64 32`). It signs download sessions; changing it signs every tester out.
   - `GITHUB_TOKEN`
3. Click **Deploy** after saving. A secret that exists only under **Builds** is available to CI, not to `env.DOWNLOADS_SESSION_KEY` in the Worker.

`wrangler.toml` lists them in `[secrets] required`. `npx wrangler deploy` will fail until both exist on the Worker.

You can also set them from your machine (does not print the value):

```bash
openssl rand -base64 32 | npx wrangler secret put DOWNLOADS_SESSION_KEY
npx wrangler secret put GITHUB_TOKEN
```

## Tester codes

Each tester gets their own download code, so one can be revoked without changing anyone
else's. Codes live in the `TESTER_CODES` KV namespace as SHA-256 hashes; the code itself is
shown once, when it is created. A code works on `/downloads` and as the HTTP Basic password
for the APT install script. Attempts are limited to 10 a minute per IP (`AUTH_LIMITER`).

```bash
node scripts/tester-codes.mjs add "Alex Kim"      # prints a new code once
node scripts/tester-codes.mjs list                # logins, last login, recent countries
node scripts/tester-codes.mjs revoke "Alex Kim"   # stops the code and its open sessions within about a minute
```

The local admin page does the same from a browser, and copies a ready-to-send invite
message with each new code:

```bash
node scripts/tester-admin.mjs    # opens http://127.0.0.1:8790 (--port, --no-open)
```

It listens only on 127.0.0.1, and its API requires the token in the URL it prints, so other
websites open in the same browser can't use it.

The commands and the admin page change the live site and need `npx wrangler login`. Add
`--local` to either to manage the codes `npx wrangler dev` uses. A code with many logins
from several countries has probably been shared: revoke it and send that tester a new one.

### One-time setup

Do these in order. Deploying before codes exist locks every tester out.

1. `npx wrangler login`
2. `npx wrangler kv namespace create clipspan-web-tester-codes`, then paste the printed id
   over `REPLACE_WITH_TESTER_CODES_NAMESPACE_ID` in `wrangler.toml`.
3. `openssl rand -base64 32 | npx wrangler secret put DOWNLOADS_SESSION_KEY`
4. Keep the current shared password working while testers switch over:
   `node scripts/tester-codes.mjs add shared --stdin`, then paste the password and press
   Ctrl-D.
5. `node scripts/tester-codes.mjs add <name>` for each tester and Google's reviewers.
6. Commit and push; Workers Builds deploys the Worker.
7. Once everyone has their own code: `node scripts/tester-codes.mjs revoke shared`, and
   delete the old `DOWNLOADS_PASSWORD` secret from the Worker.

## App Links and /pair

From ClipSpan 0.23.1 the desktop's pairing QR code holds
`https://www.clipspan.com/pair#v=1&h=<host>&p=<port>&t=<token>&f=<pin>`. The Android app
(`com.clipspan.app`) has a verified App Link for `https://www.clipspan.com/pair`, so a camera
scan opens ClipSpan when it's installed. Everything after `#` stays on the phone: browsers
never send it to this Worker.

- `GET`/`HEAD /.well-known/assetlinks.json` (`ASSET_LINKS` in `src/worker.js`): the Digital
  Asset Links statement Android checks before it trusts the App Link. It lists the SHA-256
  fingerprints of the Google Play app signing key and the upload key. The Worker answers it
  first, on every host, with a 200, `Content-Type: application/json` and
  `Cache-Control: public, max-age=300`. There is no auth and no redirect, since Android's check
  fails on either. Other methods get 405. Add a fingerprint here before shipping a build signed
  with a new key. The App Link host is `www` because `clipspan.com` redirects to it in the
  Cloudflare dashboard.
- `/pair` (`public/pair.html`, `public/assets/pair.js`): where the camera lands without
  ClipSpan or with an app older than 0.23.1. It tells people to scan again from ClipSpan's
  **Scan QR code** and links to the Google Play test. When the fragment holds a valid pairing
  code, it also shows the `https://<host>:<port>/p?t=<token>&f=<pin>` link older apps take under
  **Can't scan? Enter the pairing link**, then removes the fragment from the address bar. The
  script makes no network requests. The Worker serves `/pair` and `/pair/` with a strict CSP
  (only the site's own scripts, styles and images, no connections, no framing),
  `Referrer-Policy: no-referrer`, `Cache-Control: no-store, no-transform` and
  `X-Robots-Tag: noindex`, and redirects `/pair.html` to `/pair`, so no copy of the page goes
  out without those headers. The page has no inline scripts or styles, and repeats the policy in
  a `<meta>` tag.

Check both after a deploy:

```bash
curl -sS -o /dev/null -w '%{http_code} %{content_type} %{redirect_url}\n' https://www.clipspan.com/.well-known/assetlinks.json
# expect "200 application/json " with nothing after it (no redirect)
curl -sSI https://www.clipspan.com/pair | grep -iE 'content-security-policy|referrer-policy|cache-control|x-robots-tag'
```

Then open Google's checker, which should list the `com.clipspan.app` statement with both
fingerprints:
<https://digitalassetlinks.googleapis.com/v1/statements:list?source.web.site=https://www.clipspan.com&relation=delegate_permission/common.handle_all_urls>

Cloudflare dashboard features that inject scripts or challenge visitors must not apply to
`/.well-known/*` or `/pair`: Zaraz, Web Analytics automatic setup, Rocket Loader, Email Address
Obfuscation, Bot Fight Mode, and WAF or rate limiting rules that show a challenge. Android's
verifier is a bot and gives up on a challenge page, and an injected script on `/pair` could read
the pairing code. If any of them is on for the zone, add a rule that skips these paths.

## Workers Builds

- Build command: None
- Deploy command: `npx wrangler deploy`
- Version command: `npx wrangler versions upload` or `npx wrangler deploy`
- Root directory: `/`

Do not clear Deploy command. The Worker name in Cloudflare must match `name = "clipspan-web"`.
`package.json` has no dependencies and only holds `npm test`, so the build's automatic
dependency install has nothing to do.

Before sharing the domain publicly, complete the checklist in `SETUP.md` (HTTPS, form endpoint, contact inbox, OG image).
