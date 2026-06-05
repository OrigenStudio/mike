# Mike

Mike is a legal document assistant with a Next.js frontend, an Express backend, Supabase Auth/Postgres, and Cloudflare R2-compatible object storage.

Website: [mikeoss.com](https://mikeoss.com)

## Contents

- `frontend/` - Next.js application
- `backend/` - Express API, Supabase access, document processing, and database schema
- `backend/schema.sql` - Supabase schema for fresh databases
- `backend/migrations/` - incremental database updates for existing deployments

## Prerequisites

- Node.js 20 or newer
- npm
- git
- A Supabase project
- A Cloudflare R2 bucket, MinIO bucket, or another S3-compatible bucket
- At least one supported model provider API key: Anthropic, Google Gemini, or OpenAI
- LibreOffice installed locally if you need DOC/DOCX to PDF conversion

## Database Setup

For a new Supabase database, open the Supabase SQL editor and run:

```sql
-- copy and run the contents of:
-- backend/schema.sql
```

The schema file is based on `supabase-migration.sql` and folds in the later files in `backend/migrations/`.

For an existing database, do not run the full schema file over production data. Apply the incremental files in `backend/migrations/` instead.

## Environment

Create local env files:

```bash
touch backend/.env
touch frontend/.env.local
```

Create `backend/.env`:

```bash
PORT=3001
FRONTEND_URL=http://localhost:3000
DOWNLOAD_SIGNING_SECRET=replace-with-a-random-32-byte-hex-string
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SECRET_KEY=your-supabase-service-role-key

R2_ENDPOINT_URL=https://your-account-id.r2.cloudflarestorage.com
R2_ACCESS_KEY_ID=your-r2-access-key
R2_SECRET_ACCESS_KEY=your-r2-secret-key
R2_BUCKET_NAME=mike

GEMINI_API_KEY=your-gemini-key
ANTHROPIC_API_KEY=your-anthropic-key
OPENAI_API_KEY=your-openai-key
RESEND_API_KEY=your-resend-key
USER_API_KEYS_ENCRYPTION_SECRET=your-long-random-secret
```

Create `frontend/.env.local`:

```bash
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY=your-supabase-anon-key
NEXT_PUBLIC_API_BASE_URL=http://localhost:3001
```

Supabase values come from the project dashboard. Use the project URL for `SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_URL`, the service role key for the backend `SUPABASE_SECRET_KEY`, and the anon/public key for `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY`. If your Supabase project shows multiple key formats, use the legacy JWT-style anon and service role keys expected by the Supabase client libraries.

Provider keys are only needed for the models and email features you plan to use. Model provider keys can be configured in `backend/.env` for the whole instance, or per user in **Account > Models & API Keys**. If a provider key is present in `backend/.env`, that provider is available by default and the matching browser API key field is read-only.

## Install

Install each app package:

```bash
npm install --prefix backend
npm install --prefix frontend
```

## Run Locally

Start the backend:

```bash
npm run dev --prefix backend
```

Start the main app:

```bash
npm run dev --prefix frontend
```

Open `http://localhost:3000`.

## First Run

1. Sign up in the app.
2. If you did not set provider keys in `backend/.env`, open **Account > Models & API Keys** and add an Anthropic, Gemini, or OpenAI API key.
3. Create or open a project and start chatting with documents.

## Troubleshooting

**Sign-up confirmation email never arrives.** Confirmation emails are sent by Supabase Auth, not by Mike. For local development, the simplest fix is to disable email confirmation in **Supabase > Authentication > Providers > Email**. For production, configure custom SMTP in Supabase; the built-in mailer is heavily rate-limited and may be restricted on newer projects.

**The model picker shows a missing-key warning.** Add a key for that provider in **Account > Models & API Keys**, or configure the provider key in `backend/.env` and restart the backend.

**DOC or DOCX conversion fails.** Install LibreOffice locally and restart the backend so document conversion commands are available on the process path.

## Useful Checks

```bash
npm run build --prefix backend
npm run build --prefix frontend
npm run lint --prefix frontend
```

---

## Deployment architecture (Origen Studio fork)

> This section is specific to this fork and does not appear in upstream
> `willchen96/mike`. Edit-once / merge-clean: stays at the end of the file.

We deploy Mike across three managed platforms today (Cloudflare, Railway,
Supabase), with a fourth (Fly.io) planned for the privacy gateway.

### Status legend

- ✅ **Live in production**
- 🟡 **Staging only** (production paused at the approval gate)
- 🔵 **Planned** (repo + config exist; not yet deployed)

### Diagram

```
                           ┌──────────────────────────┐
                           │     Browser (user)       │
                           └─────────────┬────────────┘
                                         │ HTTPS
                ┌────────────────────────┴────────────────────────┐
                │  Cloudflare Workers (global edge)        🟡 / ✅ │
                │  mike-frontend-staging                          │
                │  mike-frontend-production                       │
                │  Built by @opennextjs/cloudflare from Next 16   │
                └────────────────────────┬────────────────────────┘
                                         │ HTTPS · NEXT_PUBLIC_API_BASE_URL
                ┌────────────────────────┴────────────────────────┐
                │  Railway · europe-west4 (Amsterdam)      🟡 / ✅ │
                │  mike-backend (Express, Nixpacks + LibreOffice) │
                └──┬──────────────────┬──────────────────┬────────┘
                   │                  │                  │
        ┌──────────┘                  │ S3 SDK           └──────────────┐
        │ HTTPS                       │                                 │ HTTPS  🔵
        ↓                             ↓                                 ↓
┌───────────────────┐    ┌─────────────────────────┐    ┌──────────────────────────────┐
│  Supabase Cloud   │    │     Cloudflare R2       │    │  Hey Jude (Fly.io · ams)     │
│  eu-west-1        │    │  EU jurisdiction        │    │  mike-hey-jude               │
│  Auth + Postgres  │    │  mike-staging           │    │  (privacy proxy / PII)       │
│  mike-staging     │    │  mike-prod              │    │  OrigenStudio/hey-jude (priv)│
│  mike-prod        │    │                         │    └──────────────┬───────────────┘
└───────────────────┘    └─────────────────────────┘                   │
                                                          internal 6PN │ HTTPS · anonymized
                                                                       │ prompts only
                                                       ┌───────────────┴────────────┐
                                                       │                            │
                                                       ↓                            ↓
                                          ┌────────────────────────┐   ┌──────────────────────┐
                                          │  Ollama (Fly.io · ams) │   │     OpenAI API       │
                                          │  qwen3:4b · A10 GPU    │   │  (sees placeholders, │
                                          │  internal-only, no     │   │   never raw PII)     │
                                          │  public ingress        │   └──────────────────────┘
                                          │  OrigenStudio/         │
                                          │  mike-ollama (private) │   🔵
                                          └────────────────────────┘
```

### Why this shape

- **Cloudflare Workers** for the frontend → global edge CDN, scale-to-zero,
  generous free tier. Configured by the repo (`@opennextjs/cloudflare`).
- **Railway** for the backend → long-running Express, LibreOffice subprocess
  for DOC/DOCX→PDF, 50 MB upload bodies. Needs a real container, not a
  serverless function. Nixpacks installs LibreOffice automatically.
- **Supabase Cloud** for Auth + Postgres → the app is built around Supabase
  Auth (`auth.uid()` RLS policies in `backend/schema.sql`); swapping it out
  is a multi-day refactor (see DEPLOY.md §9 notes).
- **Cloudflare R2** for object storage → S3-compatible API, **zero egress**,
  EU jurisdiction matches the rest of the stack.
- **Hey Jude + Ollama on Fly.io** (planned) → strips PII from prompts before
  they leave our infrastructure. Local LLM (qwen3:4b on GPU) does the
  context-aware detection; OpenAI never sees raw client data.

### Related repositories

- [`OrigenStudio/hey-jude`](https://github.com/OrigenStudio/hey-jude) — private
  fork of `sure-scale/hey-jude` with our Fly.io config.
- [`OrigenStudio/mike-ollama`](https://github.com/OrigenStudio/mike-ollama) —
  tiny Fly.io app running Ollama with `qwen3:4b`.
- [`willchen96/mike`](https://github.com/willchen96/mike) — upstream of this
  fork. A weekly Actions workflow checks for new commits and opens an issue.

### Where to look next

- **Teams / orgs / collaboration plan**: [docs/TEAMS_AND_ORGS_PLAN.md](docs/TEAMS_AND_ORGS_PLAN.md)
- **End-to-end deploy walkthrough**: [DEPLOY.md](DEPLOY.md)
- **CI/CD workflow**: [.github/workflows/ci-cd.yml](.github/workflows/ci-cd.yml)
- **Wrangler / Railway config**: [frontend/wrangler.jsonc](frontend/wrangler.jsonc),
  [backend/railway.json](backend/railway.json), [backend/nixpacks.toml](backend/nixpacks.toml)
