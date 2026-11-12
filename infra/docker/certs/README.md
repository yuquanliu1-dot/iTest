# Internal CA certificates

Copy the self-signed CA certificate of the internal GitLab / GitHub Enterprise into this directory, named `gitlab-ca.crt` (or any `*.crt`).

When building the api image, `infra/docker/api.Dockerfile` will automatically:

1. `COPY infra/docker/certs/*.crt /usr/local/share/ca-certificates/`
2. `update-ca-certificates`

## Not mandatory

- The build is unaffected when no .crt file exists.
- Without the CA, `git clone` against internal self-signed repos reports TLS errors; if git is also missing alongside the CA, it reports `ENOENT spawn git` (`runGit` already translates ENOENT into "git binary missing in runtime image").

## Why this directory exists

The runtime stage of `infra/docker/api.Dockerfile` is based on `node:22-bookworm-slim`, which ships neither system binaries nor ca-certificates. Cloning over HTTPS hits two blockers at once: missing git binary + distrust of the self-signed certificate. Installing the packages + update-ca-certificates solves both.
