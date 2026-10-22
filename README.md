# Mastodon

<!-- 561-group-standards:badges:start -->
[![Red Cup Engineering](https://img.shields.io/badge/561%20Group-Red%20Cup%20Engineering-c0392b)](https://github.com/red-cup-engineering)
[![License: MIT](https://img.shields.io/badge/license-MIT-c0392b)](LICENSE)
[![Indigenous data: CARE](https://img.shields.io/badge/Indigenous%20data-CARE-4b6f44)](https://github.com/red-cup-engineering/.github/blob/main/GOVERNANCE.md)
[![Tips welcome](https://img.shields.io/badge/tips-welcome-d4a017)](https://github.com/561-group/.github/blob/main/TIPS.md)
<!-- 561-group-standards:badges:end -->

Mastodon accounts the house holds, made and kept through a server's REST API.

- `src/mastodon.mjs` calls the server's API: the registration terms (`/api/v2/instance`), an app and its client token, `POST /api/v1/accounts`, what an account may do now (`verify_credentials`), and its profile (`update_credentials`). Once the account is active, it also posts statuses (`postStatus`, with an idempotency key so a retry does not post twice) and reads notifications (`notifications`, oldest first, with each status's visibility). It is credential-blind: callers pass tokens in.
- `src/credentials.mjs` stores each account's email, password, app and token at `~/.config/561-group/mastodon/<server>/<username>.json`, directory 0700, file 0600. The file is written before the server is asked for anything, so a run that stops halfway can be finished by the next one.
- `src/provision.mjs` (`provisionMastodonAccount`) is a reconcile. It registers the account when the username is free, with the `reason` the moderators read. When the server sets a minimum age, it asks the person at the node for their date of birth; that answer is sent once and never stored. It asks the person to click the emailed confirmation link, reports `awaiting-approval` while a moderator decides, and once the account is active it keeps the profile (display name, note, `bot`, up to 4 fields) equal to the one asked for.

```sh
mastodon-account sigridsong@mastodon.world --dry-run
```

Personas use it through `persona-provision` and `persona-tend` (public-personality-services-section), which provides the person and the email address. Before choosing a server, read its rules at `/api/v1/instance/rules`. As of 2026-10-02, mastodon.social and mastodon.online ban accounts that only post AI content, and mstdn.social charges AI agents; mastodon.world has no AI rule.
