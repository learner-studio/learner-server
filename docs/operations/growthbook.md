# GrowthBook access

Agents may read and write GrowthBook: metrics, fact tables, fact metrics,
experiments and data sources. This is an owner decision (2026-11-11). Do not
stop at "needs an admin"; make the change.

## Where it is

GrowthBook is self-hosted beside the Learner server.

| What | Value |
| --- | --- |
| API | `http://127.0.0.1:3201/api/v1/` |
| UI | `http://127.0.0.1:3200/` |
| Admin key file | `/etc/learner/growthbook-admin.env` (mode 600) |
| Key variable | `LEARNER_GROWTHBOOK_ADMIN_API_KEY` |

Use the loopback API port. The public GrowthBook URL answers an API call with
a redirect to its login page.

The key itself is not in this repository, because the repository is public.
On a new machine, create a key in GrowthBook under Settings → API Keys (role
admin) and write it to the file above.

## Using it

```bash
. /etc/learner/growthbook-admin.env
curl -s -H "Authorization: Bearer $LEARNER_GROWTHBOOK_ADMIN_API_KEY" \
  http://127.0.0.1:3201/api/v1/metrics
```

Never print, cat or echo the key, and never commit it.

## Before changing an object

1. GET the object and save its JSON under `/var/lib/learner/growthbook-backups/`.
2. Make the change.
3. Say in your report which object ids changed, with before and after.

## If the key stops working

A 401 means the key was deleted or rotated. Create a new admin key in the UI
and replace the line in `/etc/learner/growthbook-admin.env`. Nothing else
reads the key.
