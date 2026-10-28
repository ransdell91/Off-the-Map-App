# Off The Map Production

The production planner for the Off The Map California channel, as an installable web app.

- **App:** https://ransdell91.github.io/Off-the-Map-App/
- **Data:** Supabase project `fbskjgluladhqocklyre` (table `public.items`, members in `public.members`)
- **Sign-in:** email link or code. Only addresses in `public.members` can read or change anything.

## Files
- `index.html` — the whole app
- `manifest.webmanifest`, `icons/` — what Android needs to install it
- `sw.js` — offline support (caches the app, not your data)
- `vendor/` — the Supabase client library, bundled so the app works offline
- `supabase/` — database setup (`01_setup.sql`), data import (`02_data.sql`), members (`03_members.sql`)

## Updating
Edit and push to `main`. GitHub Pages republishes in about a minute. The app picks up the new version the next time it opens with a connection.
