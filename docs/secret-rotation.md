# Secret Rotation

How to rotate API keys, service account keys, shared tokens, and signing secrets across every place they live in this
project.

Miss a location and something breaks. Common examples:

- The web app cannot retrieve sources because `PINECONE_API_KEY` was rotated in one env but not another.
- Firestore rate limiting fails because `GOOGLE_APPLICATION_CREDENTIALS` still contains a deleted service account key.
- The WordPress plugin cannot get a JWT because backend `SECURE_TOKEN` changed but WordPress
  `CHATBOT_BACKEND_SECURE_TOKEN` was not updated.

Follow the steps in order. Do not revoke/delete the old secret until every location is updated and verified.

## 1. Identify The Secret Type

Before rotating, write down exactly what is changing and which values derive from it.

- **Provider API key**: `PINECONE_API_KEY`, `OPENAI_API_KEY`, `UPSTASH_REDIS_REST_TOKEN`, AWS access keys.
- **Service account JSON**: `GOOGLE_APPLICATION_CREDENTIALS`; this is the full JSON object, not just a key ID.
- **Shared signing/auth secret**: `SECURE_TOKEN`, `SECRET_KEY`, `CRON_SECRET`.
- **WordPress backend token**: production WordPress sets `CHATBOT_BACKEND_SECURE_TOKEN` in PHP config. It must match
  backend `SECURE_TOKEN`.

## 2. Generate The Replacement

1. Log into the provider console.
2. Create the replacement with the same project, index, scopes, and permissions as the old one.
3. Keep the old secret active until verification is complete.

For Google service accounts, create a new **JSON** key under:

`IAM & Admin` -> `Service Accounts` -> service account -> `Keys` -> `Add key` -> `Create new key` -> `JSON`

Google only lets you download the full private key JSON once at creation time. If you lose the downloaded JSON file,
delete that key and create another one.

## 3. Update Vercel

Each site is a separate Vercel project. Update every project that uses the rotated secret.

1. Vercel dashboard -> project -> **Settings** -> **Environment Variables**.
2. Edit the variable for **Production**, **Preview**, and **Development** as applicable.
3. Redeploy the latest production deployment so running instances pick up the new value. Env var edits do not
   live-update existing deployments:
   - **Deployments** -> latest production deploy -> **...** -> **Redeploy**.
4. Smoke-test the site by asking a question and checking admin flows.

### Backend `SECURE_TOKEN`

If rotating `SECURE_TOKEN`, update all backend environments that sign or verify JWTs:

- Vercel site projects.
- Local `.env.<site>` files.
- Any scripts/tests that generate JWTs.

Also update `SECURE_TOKEN_HASH` if it is maintained alongside `SECURE_TOKEN`.

## 4. Update The WordPress Plugin

The WordPress plugin does **not** read Vercel env vars. Production WordPress sets its own server-side PHP config
constant in `wp-config.php`: `CHATBOT_BACKEND_SECURE_TOKEN`.

Preferred configuration:

```php
define('CHATBOT_BACKEND_SECURE_TOKEN', 'same-value-as-backend-SECURE_TOKEN');
```

The plugin derives the WordPress token with:

```php
substr(hash('sha256', 'wordpress-' . CHATBOT_BACKEND_SECURE_TOKEN), 0, 32)
```

If WordPress is configured with `WP_API_SECRET` instead, update it to the derived value for the new backend
`SECURE_TOKEN`:

```php
define('WP_API_SECRET', 'derived-wordpress-token');
```

After updating WordPress:

1. Clear any WordPress/page/browser caches.
2. Open Settings -> Ananda AI Chatbot Security Test.
3. Verify token retrieval succeeds.
4. Ask a test question in the widget.

Expected backend log for a missed WordPress update:

```text
Invalid secret provided - no match found
TOKEN VALIDATION FAILED WITH INVALID SECRET
Request site "ananda-public" matches backend site, but the shared secret is invalid
```

That means the API URL and `Expected Site ID` are likely correct, but `CHATBOT_BACKEND_SECURE_TOKEN` or
`WP_API_SECRET` is stale.

## 5. Update The Crawler VM

The crawler runs under systemd via `docker run --env-file`. There is no UI.

```bash
ssh ubuntu@<crawler-vm>

sudo -e /srv/ananda-crawler/env/.env.<site>
# update the rotated value, save

# permissions should already be tight; verify:
sudo chmod 600 /srv/ananda-crawler/env/.env.<site>
sudo chmod 700 /srv/ananda-crawler/env

# kick off a run to confirm (env is read at container start; no daemon-reload needed)
sudo systemctl start ananda-crawler.service
journalctl -u ananda-crawler.service -f
```

Repeat for every `.env.<site>` file in `/srv/ananda-crawler/env/` that uses the rotated secret.

Related unit: [`ananda-crawler.service`](mdc:data_ingestion/crawler/deploy/vm/ananda-crawler.service).

Quick Pinecone health check, run outside the crawler container:

```bash
/app/.venv/bin/python /app/crawler/bin/pinecone_health_check.py
```

## 6. Update Local Development

Every developer must update their local `.env.<site>` at the repo root for each site they work on:

- `.env.ananda`
- `.env.ananda-public`
- `.env.jairam`
- `.env.photo`
- `.env.crystal`
- any others in use

Then restart any running dev servers or ingestion scripts. Next.js reads env on process start, so a restart is required.

Share the new secret via the team secret store. Do **not** paste secrets into Slack, email, or commits.

## 7. Update Other Hosts

Before revoking the old secret, scan for other surfaces:

- GitHub Actions secrets: Repo -> Settings -> Secrets and variables -> Actions.
- Local WordPress test sites.
- Production WordPress hosting.
- Cron or operational scripts.
- Crawler VM env files.

## 8. Revoke The Old Secret

Only after every location is updated and verified:

1. Provider console -> delete/revoke the old secret.
2. Monitor logs for about 24 hours for unexpected `401`, `403`, or provider-specific auth errors.

## Troubleshooting

### Pinecone Auth Failure

```text
PineconeAuthorizationError: The API key you provided was rejected
```

The current `PINECONE_API_KEY` does not have access to `PINECONE_INDEX_NAME`, or one env still has the old key.
Update Vercel, local `.env.<site>`, and the crawler VM as applicable.

### Firestore Auth Failure

```text
Request had invalid authentication credentials. Expected OAuth 2 access token
```

`GOOGLE_APPLICATION_CREDENTIALS` is stale or malformed. Replace it with the full service account JSON object for the
current key. The JSON must include fields like `type`, `project_id`, `private_key_id`, `private_key`, and
`client_email`.

### WordPress Token Failure

```text
POST /api/get-token 403
Invalid secret provided - no match found
```

If the expected and actual site IDs match, this is not a site mismatch. Update `CHATBOT_BACKEND_SECURE_TOKEN` in
WordPress `wp-config.php` to match backend `SECURE_TOKEN`, or update `WP_API_SECRET` to the new derived token.

### Web App Fails After Vercel Env Update

Env var edits do not apply to already-running deployments. Trigger a redeploy.

### Local Tests Or Dev Server Fail After Rotation

Old values are still in local `.env.<site>` files, or the dev server was not restarted.

## Secret Inventory

Secrets that typically need coordinated rotation across the same surfaces:

| Secret                           | Where                                                   |
| -------------------------------- | ------------------------------------------------------- |
| `PINECONE_API_KEY`               | Vercel, crawler VM, local dev                           |
| `OPENAI_API_KEY`                 | Vercel, crawler VM, local dev                           |
| `AWS_ACCESS_KEY_ID`              | Vercel, crawler VM, local dev                           |
| `AWS_SECRET_ACCESS_KEY`          | Vercel, crawler VM, local dev                           |
| `GOOGLE_APPLICATION_CREDENTIALS` | Vercel, crawler VM, local dev                           |
| `UPSTASH_REDIS_REST_TOKEN`       | Vercel, local dev                                       |
| `SECURE_TOKEN`                   | Vercel, local dev, WordPress via `CHATBOT_BACKEND_SECURE_TOKEN` |
| `SECURE_TOKEN_HASH`              | Vercel, local dev                                       |
| `SECRET_KEY`                     | Vercel, local dev                                       |
| `CRON_SECRET`                    | Vercel, cron callers                                    |
| `CHATBOT_BACKEND_SECURE_TOKEN`   | WordPress `wp-config.php`                               |
| `WP_API_SECRET`                  | WordPress `wp-config.php`, only if not deriving token   |

See [`.env.example`](mdc:.env.example) for the full list.
