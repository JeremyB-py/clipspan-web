# ClipSpan website seed

Static site for **clipspan.com**, deployed as a Cloudflare Worker with static assets.

- Public pages: `public/index.html`, `public/privacy.html`
- Shared theme: `public/assets/site.css`
- Tester downloads: `public/downloads.html`, gated by [`src/worker.js`](src/worker.js)
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
