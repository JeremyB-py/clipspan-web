# ClipSpan website seed

Static site for **clipspan.com**, deployed as a Cloudflare Worker with static assets.

- Public pages: `public/index.html`, `public/privacy.html`
- Shared theme: `public/assets/site.css`
- Tester downloads: `public/downloads.html`, gated by [`src/worker.js`](src/worker.js)
- Desktop in-app updater: `GET /updates/latest.json` (latest release manifest, cached 5 minutes) and `GET /updates/v<version>/<file>` (AppImage, NSIS `-setup.exe`, or `.msi` only). Both are public without the tester password, because installed apps cannot sign in, and rate limited per IP (30/min for the manifest, 6/min for files; `[[ratelimits]]` in `wrangler.toml`). Integrity comes from the minisign pubkey compiled into the app, not from this Worker. APKs, `.deb`s, and the `/downloads` listing stay gated.
- Tester APT origin: `https://apt.clipspan.com` (this Worker custom domain; `public/apt/` at URL root). `https://www.clipspan.com/apt` is the same tree. ClipSpan `./scripts/publish-apt-repo.sh --push` replaces `public/apt` (do not edit that tree by hand). Attach `apt.clipspan.com` on Worker **clipspan-web** in the Cloudflare dashboard.
- Setup checklist and Reddit notes: [SETUP.md](SETUP.md)

Preview the static pages:

```bash
python3 -m http.server 8080 --directory public
```

Preview downloads auth and the GitHub proxy:

```bash
# .dev.vars in the repo root needs DOWNLOADS_PASSWORD and GITHUB_TOKEN
npx wrangler dev
```

## Cloudflare secrets

Build settings env vars are **not** the Worker bindings. Set runtime secrets on the Worker itself:

1. Workers & Pages → **clipspan-web** → **Settings** → **Variables and Secrets**
2. Add two entries, type **Secret**:
   - `DOWNLOADS_PASSWORD`
   - `GITHUB_TOKEN`
3. Click **Deploy** after saving. A secret that exists only under **Builds** is available to CI, not to `env.DOWNLOADS_PASSWORD` in the Worker.

`wrangler.toml` lists them in `[secrets] required`. `npx wrangler deploy` will fail until both exist on the Worker.

You can also set them from your machine (does not print the value):

```bash
npx wrangler secret put DOWNLOADS_PASSWORD
npx wrangler secret put GITHUB_TOKEN
```

## Workers Builds

- Build command: None
- Deploy command: `npx wrangler deploy`
- Version command: `npx wrangler versions upload` or `npx wrangler deploy`
- Root directory: `/`

Do not clear Deploy command. The Worker name in Cloudflare must match `name = "clipspan-web"`.

Before sharing the domain publicly, complete the checklist in `SETUP.md` (HTTPS, form endpoint, contact inbox, OG image).
