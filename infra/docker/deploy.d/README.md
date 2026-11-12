# deploy.d/ — multi-environment release credentials directory

Each file holds the release configuration for one target environment; the file name is the environment name (e.g. `prod.env` / `staging.env` / `dev.env`).
`release.sh` picks the file to load via `--env <name>`, defaulting to `prod`.

## First use

```bash
cd infra/docker/deploy.d
cp .env.example <env>.env
$EDITOR <env>.env          # fill in the target server's SSH credentials and remote path
```

Name files after their target (e.g. `prod228.env` / `staging-31.env`) so multiple prod hosts are easy to tell apart at a glance.

To add an environment, simply `cp <env>.env <other>.env` and edit the values; existing env files are never overwritten.

## File naming convention

| File | How it is loaded |
| --- | --- |
| `.env.example` | Template, committed to git |
| `README.md` | This document, committed to git |
| `<env>.env` | Actual config, excluded via gitignore |

`release.sh --env staging` attempts to load `deploy.d/staging.env`; a missing file causes an error exit.

## Credential storage safety

- Everything in this directory except the template and README is covered by the `deploy.d/*` gitignore wildcard
- No `<env>.env` should ever be committed explicitly via `git add`
- Cross-machine sync: prefer a password manager / 1Password / KeePass; do **not** push to any remote

## sshpass dependency

If `DEPLOY_SSH_PASSWORD` in `<env>.env` is non-empty, the local machine needs `sshpass`:

- macOS: `brew install hudochenkov/sshpass/sshpass`
- Debian/Ubuntu: `apt install sshpass`

Leaving `DEPLOY_SSH_PASSWORD` empty uses the local ssh key instead, with no sshpass dependency.

## Common workflows

```bash
# Dry-run packaging for prod (no actual upload)
infra/docker/release.sh --env prod --dry-run

# Real release to prod
infra/docker/release.sh --env prod

# Release to staging
infra/docker/release.sh --env staging

# Custom environment (temporary testing)
cp deploy.d/.env.example deploy.d/sandbox.env
$EDITOR deploy.d/sandbox.env
infra/docker/release.sh --env sandbox --dry-run
```
