# API Key Rotation

How to rotate a third-party API key (Pinecone, OpenAI, Google, AWS, etc.) across every place it lives in this project.
Miss a location and something silently breaks (usually the crawler, since it runs unattended on a VM).

Follow the steps in order. Do not revoke the old key until every location is updated and verified.

## 1. Generate the new key

1. Log into the provider (e.g. [Pinecone console](https://app.pinecone.io/)).
2. Create the new key. Scope it to the same project/permissions as the old one.
3. Keep the old key active until step 6.

## 2. Update Vercel (production web app)

Each site is a separate Vercel project. Update every project that uses the rotated key.

1. Vercel dashboard → project → **Settings** → **Environment Variables**.
2. Edit the variable (e.g. `PINECONE_API_KEY`) for **Production**, **Preview**, and **Development** as applicable.
3. Redeploy the latest production deployment so running instances pick up the new value (env var edits do not
   live-update existing deployments):
   - **Deployments** → latest production deploy → **⋯** → **Redeploy**.
4. Smoke-test the site (ask a question, check admin dashboard).

## 3. Update the crawler VM

The crawler runs under systemd via `docker run --env-file`. There is no UI.

```bash
ssh ubuntu@<crawler-vm>

sudo -e /srv/ananda-crawler/env/.env.<site>
# update PINECONE_API_KEY=... (and any other rotated keys), save

# permissions should already be tight; verify:
sudo chmod 600 /srv/ananda-crawler/env/.env.<site>
sudo chmod 700 /srv/ananda-crawler/env

# kick off a run to confirm (env is read at container start — no daemon-reload needed)
sudo systemctl start ananda-crawler.service
journalctl -u ananda-crawler.service -f
```

Repeat for every `.env.<site>` file in `/srv/ananda-crawler/env/` that uses the rotated key.

Related unit: [`ananda-crawler.service`](mdc:data_ingestion/crawler/deploy/vm/ananda-crawler.service).

Quick health check (runs outside the crawler container):

```bash
/app/.venv/bin/python /app/crawler/bin/pinecone_health_check.py
```

## 4. Update local development

Every developer must update their local `.env.<site>` at the repo root for each site they work on:

- `.env.ananda`
- `.env.ananda-public`
- `.env.jairam`
- `.env.photo`
- `.env.crystal`
- …and any others in use

Then restart any running dev servers / ingestion scripts. Next.js reads env on process start, so a restart is required.

Share the new key via the team secret store (1Password / shared vault). Do **not** paste keys into Slack, email, or
commit them.

## 5. Update any other hosts that hold the key

Before revoking the old key, scan for other surfaces:

- GitHub Actions secrets — check [Repo → Settings → Secrets and variables → Actions](https://github.com/) if the key is
  referenced in `.github/workflows/*.yml`.

## 6. Revoke the old key

Only after every location is updated and verified:

1. Provider console → delete/revoke the old key.
2. Monitor logs for ~24 hours for unexpected `401 Unauthorized` errors (crawler, Vercel function logs, ingestion
   scripts).

## Troubleshooting

### Crawler fails with `401 Unauthorized`

```text
Error checking Pinecone index: (401)
Reason: Unauthorized
HTTP response body: Invalid API Key
```

The VM's `.env.<site>` file still has the old key. See step 3.

### Web app fails after Vercel env update

Env var edits don't apply to already-running deployments. Trigger a redeploy (step 2.3).

### Local tests fail after rotation

Old key is still in your local `.env.<site>`. See step 4.

## Key inventory

Keys that typically need coordinated rotation across the same surfaces:

| Key                              | Where                         |
| -------------------------------- | ----------------------------- |
| `PINECONE_API_KEY`               | Vercel, crawler VM, local dev |
| `OPENAI_API_KEY`                 | Vercel, crawler VM, local dev |
| `AWS_ACCESS_KEY_ID` /            | Vercel, crawler VM, local dev |
| `AWS_SECRET_ACCESS_KEY`          |                               |
| `GOOGLE_APPLICATION_CREDENTIALS` | Vercel, crawler VM, local dev |
| `UPSTASH_REDIS_REST_TOKEN`       | Vercel, local dev             |
| `SECURE_TOKEN` /                 | Vercel, local dev             |
| `SECRET_KEY`                     |                               |

See [`.env.example`](mdc:.env.example) for the full list.
