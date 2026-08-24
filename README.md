# ClipSpan website seed

Static one-page site for **clipspan.com**, meant to be copied into a separate website repository.

- Public pages: `index.html`, `privacy.html`
- Tester downloads (unlinked): `downloads.html`, gated by Cloudflare Pages Functions
- Setup checklist and Reddit notes: [SETUP.md](SETUP.md)

Preview the static pages:

```bash
python3 -m http.server 8080
```

Preview downloads auth and the GitHub proxy:

```bash
# .dev.vars needs DOWNLOADS_PASSWORD and GITHUB_TOKEN
npx wrangler pages dev
```

On Cloudflare Pages, set those same values as production secrets. Do not protect `/` or `/privacy.html`.
Pretty URLs serve `/downloads` and `/privacy` without a `_redirects` file.

Before sharing the domain publicly, complete the checklist in `SETUP.md` (HTTPS, form endpoint, contact inbox, OG image).
