# ClipSpan website seed

Static site for **clipspan.com**, deployed as a Cloudflare Worker with static assets.

- Public pages: `public/index.html`, `public/privacy.html`
- Shared theme: `public/assets/site.css`
- Hero video: `public/assets/launch-video.mp4` is a web encode of `marketing/launch-video/final/clipspan-testing-launch-16x9-v10.mp4` in the ClipSpan repo, and `launch-video-poster.jpg` is that folder's 16:9 thumbnail. To replace it, encode the new master with `ffmpeg -i <master> -c:v libx264 -preset slow -crf 23 -profile:v high -pix_fmt yuv420p -c:a aac -b:a 160k -movflags +faststart public/assets/launch-video.mp4` and bump `?v=` in `index.html`. Static assets ignore `Range`, so the Worker answers byte-range requests for `/assets/*.mp4` and `*.webm` itself. Safari won't play video without them.
- Tester downloads: `public/downloads.html`, gated by per-tester codes in [`src/worker.js`](src/worker.js) (see [Tester codes](#tester-codes))
- Desktop in-app updater: `GET /updates/latest.json` (latest release manifest, cached 5 minutes) and `GET /updates/v<version>/<file>` (AppImage, NSIS `-setup.exe`, or `.msi` only). Both are public without a tester code, because installed apps cannot sign in, and rate limited per IP (30/min for the manifest, 6/min for files; `[[ratelimits]]` in `wrangler.toml`). Integrity comes from the minisign pubkey compiled into the app, not from this Worker. The APK, the `/downloads` listing, and the APT install script stay gated. The APT repo's package lists and `.deb`s are public, as `install.sh` requires.
- Tester APT origin: `https://apt.clipspan.com` (this Worker custom domain; `public/apt/` at URL root). `https://www.clipspan.com/apt` is the same tree. ClipSpan `./scripts/publish-apt-repo.sh --push` replaces `public/apt` (do not edit that tree by hand). Attach `apt.clipspan.com` on Worker **clipspan-web** in the Cloudflare dashboard.
- Setup checklist and Reddit notes: [SETUP.md](SETUP.md)

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

## Workers Builds

- Build command: None
- Deploy command: `npx wrangler deploy`
- Version command: `npx wrangler versions upload` or `npx wrangler deploy`
- Root directory: `/`

Do not clear Deploy command. The Worker name in Cloudflare must match `name = "clipspan-web"`.

Before sharing the domain publicly, complete the checklist in `SETUP.md` (HTTPS, form endpoint, contact inbox, OG image).
