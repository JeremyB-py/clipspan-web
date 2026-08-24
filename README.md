# ClipSpan website seed

Static one-page site for **clipspan.com**, meant to be copied into a separate website repository.

- Public pages: `index.html`, `privacy.html`
- Shared theme: `assets/site.css`
- Tester downloads (linked from the homepage): `downloads.html`, gated by the Worker in `src/worker.js`
- Setup checklist and Reddit notes: [SETUP.md](SETUP.md)

Preview the static pages:

```bash
python3 -m http.server 8080
```

Preview downloads auth and the GitHub proxy:

```bash
# .dev.vars needs DOWNLOADS_PASSWORD and GITHUB_TOKEN
npx wrangler dev
```

On Cloudflare, set those same values as production secrets. Do not protect `/` or `/privacy.html`.
Pretty URLs serve `/downloads` and `/privacy`.

This project uses **Workers Builds** (Git + `npx wrangler deploy`), not classic Pages. Leave the dashboard as:

- Build command: None
- Deploy command: `npx wrangler deploy`
- Version command: `npx wrangler versions upload` for preview branches, or `npx wrangler deploy` if that field cannot be empty
- Root directory: `/`

Do not clear Deploy command. An empty value is rejected (`Invalid request body`). The Worker entry is [`src/worker.js`](src/worker.js); static files come from the repo root via `[assets]` in [`wrangler.toml`](wrangler.toml). The Worker name in Cloudflare must match `name = "clipspan-web"`.

Before sharing the domain publicly, complete the checklist in `SETUP.md` (HTTPS, form endpoint, contact inbox, OG image).
