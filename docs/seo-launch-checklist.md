# Pi Deck SEO launch checklist

## GitHub Pages

- [ ] Merge the Pages workflow and ensure the `site/` directory is present on `main`.
- [ ] In **Settings → Pages**, set **Source** to **GitHub Actions**.
- [ ] Run **Deploy site to GitHub Pages** or merge a change under `site/` to trigger it.
- [ ] Confirm the deployment succeeds and `https://liusuzeng.github.io/pi-deck/` loads over HTTPS.
- [ ] Check the repository-root path: all styles, images, canonical URLs, sitemap links, and navigation must work under `/pi-deck/`.

## Repository discovery

- [ ] Set the repository homepage to `https://liusuzeng.github.io/pi-deck/`.
- [ ] Set the description to: `A local macOS desktop app for running, monitoring, and steering multiple Pi coding-agent sessions.`
- [ ] Add topics: `pi-coding-agent`, `coding-agents`, `ai-agents`, `macos`, `electron`, `react`, `typescript`, and `developer-tools`.
- [ ] Upload the branded 1280 × 640 repository social preview in **Settings → General → Social preview**.

## Search and sharing checks

- [ ] Verify the production URL in Google Search Console (URL-prefix verification is suitable for GitHub Pages).
- [ ] Submit `https://liusuzeng.github.io/pi-deck/sitemap.xml` after it is publicly available.
- [ ] Use Search Console URL Inspection to request indexing for the homepage after the site is stable.
- [ ] Inspect page source: confirm one descriptive title, meta description, canonical URL, Open Graph tags, and `SoftwareApplication` structured data are present.
- [ ] Test the shared URL in LinkedIn Post Inspector, X Card Validator or another current card inspector, and a Slack/Discord message; refresh cached previews if needed.

## Rollback

- [ ] If the latest deploy is incorrect, revert the offending commit on `main`; Pages will deploy the reverted `site/` automatically.
- [ ] For an urgent stop, disable GitHub Pages in **Settings → Pages** or disable the workflow; record the reason and re-enable only after verification.
- [ ] Keep the prior social-preview asset and deployment commit available so repository metadata can be restored quickly.
