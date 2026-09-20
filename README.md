# Repo Manager

Sign in with GitHub, see all your repositories, switch them between public and private with one click, and delete them (with a type-the-name confirmation).

**Select several repos at once** with the checkboxes (or "Select all shown", which respects your search and filter), then use the bar at the bottom to make them all public, all private, or delete them together. Bulk delete asks you to type e.g. `delete 3 repositories` and lists every repo that will be removed.

## 1. Register a GitHub OAuth App
1. Go to https://github.com/settings/developers → **OAuth Apps** → **New OAuth App**
2. Homepage URL: `http://localhost:3000`
3. Authorization callback URL: `http://localhost:3000/auth/callback`
4. Create it, then generate a **client secret**.

## 2. Run it
```bash
cp .env.example .env      # paste in your Client ID / Secret and a random SESSION_SECRET
npm install
npm start
```
Open http://localhost:3000

## Permissions requested
- `repo` – list your repos and change visibility
- `delete_repo` – delete repos

## Notes
- The GitHub token stays on the server in the session. The browser never sees it.
- Deleting requires typing `owner/repo`, and the server re-checks it.
- Only repos where you have **admin** rights are listed.
- Organization repos: the org may need to approve the OAuth app (org Settings → Third-party access), and some orgs restrict who can change visibility or delete.
- Forks can't always be made private; GitHub's error message is shown in the app.

## Before deploying
- Use HTTPS and set `BASE_URL` to your https URL (this also turns on secure cookies). Update the callback URL in your GitHub OAuth App to match.
- Replace the default in-memory session store with Redis or similar (e.g. `connect-redis`).
- Never commit `.env`.
