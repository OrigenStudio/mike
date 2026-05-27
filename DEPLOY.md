# Deploying Mike — Railway (backend) + Cloudflare Workers (frontend)

This runbook deploys Mike with:

- **Frontend** on Cloudflare Workers via `@opennextjs/cloudflare`
- **Backend** on Railway via Nixpacks (LibreOffice baked in)
- **Database / Auth** on managed Supabase
- **Object storage** on Cloudflare R2

Estimated first-time setup: 30–45 minutes.

## 0. Prerequisites

- A GitHub fork of this repo (Railway and Cloudflare both deploy from a Git remote)
- `node` 20+, `npm`, `wrangler` (`npm i -g wrangler`)
- Accounts: Cloudflare, Railway, Supabase
- (Optional) A custom domain pointed at Cloudflare DNS

## 1. Provision Supabase

1. Create a new Supabase project. Pick a region near your backend region.
2. SQL editor → paste the contents of `backend/schema.sql` → Run.
3. **Authentication → Providers → Email**: for staging, disable email confirmations. For production, configure custom SMTP (the built-in mailer is heavily rate-limited).
4. Copy three values from **Project Settings → API**:
   - Project URL → `SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_URL`
   - `anon` / public key → `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY`
   - `service_role` key → `SUPABASE_SECRET_KEY` (backend only — never expose to the browser)

If you see new-format JWKS keys, use the legacy JWT-format anon and service role keys; the `@supabase/supabase-js` client expects those.

## 2. Provision Cloudflare R2

1. Cloudflare dashboard → R2 → **Create bucket** named `mike` (or any name, match `R2_BUCKET_NAME`).
2. R2 → **Manage API Tokens** → Create token with Object Read & Write on this bucket. Save:
   - Access Key ID → `R2_ACCESS_KEY_ID`
   - Secret Access Key → `R2_SECRET_ACCESS_KEY`
   - Endpoint URL (`https://<account-id>.r2.cloudflarestorage.com`) → `R2_ENDPOINT_URL`

## 3. Generate secrets

```bash
# 32-byte hex, signs /download/:token URLs
openssl rand -hex 32
# Long secret used to encrypt per-user API keys at rest in Supabase
openssl rand -base64 48
```

Save the first as `DOWNLOAD_SIGNING_SECRET`, the second as `USER_API_KEYS_ENCRYPTION_SECRET`.

## 4. Deploy the backend to Railway

1. `railway login` (or use the dashboard).
2. New Project → Deploy from GitHub → select your fork → set **Root Directory** to `backend`.
3. Railway will detect `backend/nixpacks.toml` and `backend/railway.json`. The image installs LibreOffice automatically; build is `npm install && npm run build`, start is `npm start`, health check is `GET /health`.
4. **Variables** tab → paste everything from `backend/.env.example`, filled in with real values:
   - `NODE_ENV=production`
   - `FRONTEND_URL` — leave as `https://placeholder` for now; you'll update after step 5
   - `DOWNLOAD_SIGNING_SECRET`, `USER_API_KEYS_ENCRYPTION_SECRET` from step 3
   - All `SUPABASE_*` from step 1
   - All `R2_*` from step 2
   - At least one model provider key (Anthropic / Gemini / OpenAI) — or leave all unset to require per-user keys
5. **Settings → Networking → Generate Domain.** Copy the public URL (e.g. `https://mike-backend-production.up.railway.app`).
6. Verify: `curl https://<railway-url>/health` → `{"ok":true}`.

## 5. Deploy the frontend to Cloudflare Workers

1. `cd frontend && npm install` (locally) then `wrangler login`.
2. Create `frontend/.env.local` with build-time values (these get inlined into the bundle by Next.js):
   ```bash
   NEXT_PUBLIC_SUPABASE_URL=...
   NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY=...
   NEXT_PUBLIC_API_BASE_URL=https://<railway-backend-url>
   ```
3. `npm run deploy` — runs `opennextjs-cloudflare build && opennextjs-cloudflare deploy`, using `frontend/wrangler.jsonc`.
4. The first deploy prints a `*.workers.dev` URL. Open it.

The Worker bundle bakes `NEXT_PUBLIC_*` values at build time — to rotate them you must rebuild and redeploy.

`frontend/src/lib/storage.ts` references `R2_*` env vars but is currently unused, so the Worker does not need R2 credentials. If you add server-side R2 calls to a Next.js route handler later, add the secrets via `wrangler secret put`.

## 6. Wire frontend ↔ backend together

Now that you know both URLs:

1. **Railway → backend variables → `FRONTEND_URL`** = the Workers URL (or your custom domain). Save → backend redeploys. This is enforced by CORS in `backend/src/index.ts:93`, so getting the host wrong will break the app.
2. (Optional) Map a custom domain to the Worker: Cloudflare dashboard → Workers → mike-frontend → Settings → Triggers → Add Custom Domain.
3. (Optional) Map a custom subdomain (e.g. `api.example.com`) to Railway via CNAME, then update `NEXT_PUBLIC_API_BASE_URL`, rebuild and redeploy the frontend.

## 7. Smoke test

1. Open the frontend URL → sign up.
2. (Local Supabase auth) confirm the email or disable confirmations.
3. **Account → Models & API Keys** → add a provider key if you didn't set one server-side.
4. Create a project → upload a `.docx` → start a chat. This exercises:
   - Supabase auth (login, project create)
   - R2 upload (file lands in bucket)
   - LibreOffice conversion (preview renders)
   - Model provider streaming (chat replies)

If `.docx → .pdf` fails on Railway: check the Nixpacks build log shows `libreoffice` was installed. The `backend/nixpacks.toml` declares it; if Railway swapped builders for some reason, re-enable Nixpacks in **Settings → Build**.

## 8. Ongoing operations

- **Backend updates**: push to your GitHub default branch → Railway redeploys.
- **Frontend updates**: `npm run deploy` from `frontend/`, or wire up a Cloudflare Pages-style GitHub action. Note: `NEXT_PUBLIC_*` changes require a rebuild.
- **DB migrations**: drop new files into `backend/migrations/` and apply each via Supabase SQL editor. **Do not** re-run `backend/schema.sql` against production.
- **Secret rotation**: rotate `DOWNLOAD_SIGNING_SECRET` invalidates any outstanding signed download URLs but does not affect uploaded objects. Rotating `USER_API_KEYS_ENCRYPTION_SECRET` will lock users out of their stored API keys — only do this with a re-encryption migration in place.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `CORS` errors in the browser | `FRONTEND_URL` on the backend doesn't match the actual frontend origin | Set Railway `FRONTEND_URL` to the exact Worker URL (incl. scheme) |
| Sign-up emails never arrive | Default Supabase mailer is rate-limited | Configure custom SMTP in Supabase Auth |
| DOC/DOCX upload returns 500 | LibreOffice missing from the runtime image | Confirm Nixpacks build, `nixPkgs = ["...", "libreoffice"]` in `backend/nixpacks.toml` |
| Health check failing on Railway | App crashed at boot — usually a missing required env var | Check Railway logs for the thrown var name; `DOWNLOAD_SIGNING_SECRET` and Supabase keys are required at startup |
| `npm run deploy` fails with "wrangler.toml not found" or similar | Wrangler can't locate config | `frontend/wrangler.jsonc` is shipped — make sure you run the command from `frontend/` |
| Frontend builds but env values are `undefined` at runtime | `NEXT_PUBLIC_*` only inlines if present at **build** time | Re-run `npm run deploy` after writing `frontend/.env.local` |

## 9. CI/CD with GitHub Actions (staging + production)

`.github/workflows/ci-cd.yml` is a single workflow that runs build/lint on every PR and
deploys the changed package(s) to the environment that matches the branch. Each deploy job
is gated behind its CI job, so a broken build never ships.

```
PR -> main or staging   ci-backend + ci-frontend            (build / lint / typecheck)
push to staging         CI, then deploy changed pkg(s) -> STAGING env
push to main            CI, then deploy changed pkg(s) -> PRODUCTION env
"Run workflow"          manual deploy; env follows the branch you run it from
```

Branch flow: feature branch → PR into `staging` → merge deploys to staging → open a PR
from `staging` into `main` → merge deploys to production.

### Environment model

The deploy jobs compute their GitHub Environment from the branch
(`main` → `production`, otherwise `staging`). Because of that, **the same secret/variable
names live in both environments with different values**, and each deploy automatically
reads the right set. This is why staging can never accidentally touch prod: different
Supabase project, Railway environment, Cloudflare Worker, and R2 bucket behind identical
names.

| Target | Branch | GitHub Environment | Cloudflare Worker |
|---|---|---|---|
| Staging | `staging` | `staging` | `mike-frontend-staging` |
| Production | `main` | `production` | `mike-frontend-production` |

### One-time setup

You provision the **staging** and **production** infrastructure separately first — repeat
steps 1–2 (Supabase) and the R2/Railway/Cloudflare setup from earlier in this doc **twice**,
once per environment. Suggested naming: Supabase projects `mike-staging` / `mike-prod`,
R2 buckets `mike-staging` / `mike`, Railway environments `staging` / `production`,
Workers `mike-frontend-staging` / `mike-frontend-production`.

1. **Cloudflare API token (shared).** Dashboard → My Profile → API Tokens → Create Token →
   "Edit Cloudflare Workers". Both Workers live in one account, so one token + Account ID
   covers both environments.
2. **Two Railway project tokens.** In *each* Railway environment: Project → Settings →
   Tokens → create a token scoped to that environment. You'll get one staging token and one
   production token.
3. **Create the two GitHub Environments.** Repo → Settings → Environments → New environment
   → `staging`, then again → `production`.
4. **Add repo-level secrets** (Settings → Secrets and variables → Actions → Secrets) —
   shared across both environments:

   | Secret | Value |
   |---|---|
   | `CLOUDFLARE_API_TOKEN` | from step 1 |
   | `CLOUDFLARE_ACCOUNT_ID` | your Cloudflare account id |

5. **Add environment secrets** — set these in **both** the `staging` and `production`
   environments (Settings → Environments → *env* → Add secret), each with that env's values:

   | Secret | Value (per environment) |
   |---|---|
   | `NEXT_PUBLIC_SUPABASE_URL` | that env's Supabase project URL |
   | `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY` | that env's Supabase anon key |
   | `NEXT_PUBLIC_API_BASE_URL` | that env's backend URL |
   | `RAILWAY_TOKEN` | that env's Railway project token (step 2) |

6. **Add an environment variable** — in both environments (Environments → *env* → Variables):

   | Variable | Value |
   |---|---|
   | `RAILWAY_SERVICE` | backend service name in that Railway env, e.g. `mike-backend` |

7. **Set the backend env vars in Railway**, per environment (these live in Railway, not
   GitHub): everything from `backend/.env.example`, pointing each env at its own Supabase /
   R2 / `FRONTEND_URL` (= that env's Worker URL). See §4.
8. *(Recommended)* Add a **required-reviewers** rule on the `production` environment
   (Settings → Environments → production) so prod deploys pause for a one-click approval.
   Optionally set its **Deployment branches** to `main` only. Staging stays fully automatic.
9. *(Recommended)* Branch protection on `main` **and** `staging` → require status checks
   `ci-backend` and `ci-frontend`. They always run on PRs (never skipped), so they won't
   hang a PR. Do **not** mark the deploy jobs as required — they only run on push.

### Notes & gotchas

- **`NEXT_PUBLIC_*` are build-time and per-environment.** CI builds with harmless
  placeholders just to compile; each deploy job rebuilds with that environment's real values
  and inlines them into the Worker bundle. The staging and production bundles are therefore
  genuinely different artifacts — there's no "promote the same build", each env builds its own.
- **Backend builds remotely.** Each deploy runs `railway up --ci`, which uploads `backend/`,
  lets Railway's Nixpacks builder (with LibreOffice) build the image, waits for the deploy,
  and fails the job if the deploy fails. The env-scoped `RAILWAY_TOKEN` decides which Railway
  environment receives it. If your Railway CLI predates the `--ci` flag, switch to `--detach`
  (note: `--detach` won't surface remote build failures back to the Action).
- **Monorepo path filtering.** The `changes` job (dorny/paths-filter) decides which deploy
  fires. A push touching only `docs/` or `DEPLOY.md` runs CI but deploys nothing. A manual
  `workflow_dispatch` run bypasses the filter and deploys both packages to the branch's env.
- **Secrets never reach PRs from forks.** Fork PRs run CI only and cannot read secrets, so
  external contributions can't trigger a deploy or leak credentials.
