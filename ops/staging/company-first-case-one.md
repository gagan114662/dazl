# Staging case-one company-first pilot

This private one-shot uses the existing staging tenant's saved Anthropic key.
It never uses an app/provider key, the shared trial, or a production secret.
It does not run the old or judge arm and does not affect paired scorecards.

## Preflight and installation

1. Deploy the exact approved build to staging through the normal workflow;
   verify the exact full SHA and SQLite on staging health. The app unit and
   deploy script bind User=dazl-staging, `/srv/dazl-staging/current/web`,
   `/etc/dazl-staging/env`, and root-owned
   `/var/lib/dazl-staging-deploy/release.env`; the build additionally stamps
   its own web `.build-commit`. Do not use a checkout or a mutable command
   loaded from the private material. Require the exact reviewed branch's
   installed `web/scripts/company-first-staging-case-one.mts` with a static
   same-process import of the production verifier/finder binder. This command
   must not be installed, enabled, or substituted if that composition is
   not present on the approved release.
2. Store two distinct signing values in root-owned, mode 0600
   `/etc/dazl-staging/case-one-signing.env` for systemd only:
   `DAZL_STAGING_CASE_ONE_SIGNING_KEY` and
   `DAZL_STAGING_SCORECARD_PROOF_KEY`, each 32 random bytes in lowercase
   hex. They must differ from each other and from the paired protocol's
   `DAZL_SCORECARD_SIGNING_KEY`. Do not copy any key from production.
3. Use the exact opted-in owner membership on the requested staging workspace.
   If not enrolled, apply the already-reviewed workspace enrollment flow, not
   manual SQL. When issuing the one-use ticket, privately resolve the one
   approved case-1 preset and exact current owner/workspace IDs and revision.
   Only the opaque preset digest goes in the ticket. Do not copy identities,
   presets, grants or answers into chat, run logs or command lines.

## Existing server-side private protocol

The material is one JSON object supplied through private stdin only, with
`tenantId`, `actorId`, `jobId`, `signedToken`, `reviewedInput`
(the existing exact query/ICP/seller/offer/sources subject), and
`proofRequest` (`expiresAt`, `mac`). The decoded ticket is the existing
13-field tuple with stage-only signer domain `dazl-staging-case-one-ticket:v1\n`,
one opaque preset in the roster, attempt=1, ordinal=1, lane=new, and max
15 minutes. Use the existing canonical subject MAC with the case-one signing
key and existing staging proof MAC domain
`dazl-staging-scorecard-proof/v1` with its separate key. The cohort is
SHA256(JSON.stringify(['dazl-staging-case-one:v1',tenantId,fullReleaseSha])).
There is no signer or case resolver in the launch process. An independently
signed new job for the same workspace and release cannot restore the consumed
slot. Membership/flag/revision are checked again at admission and during I/O.

If the reviewed command exists on the staging release and the authorized
operator has the signed envelope already, the manual one-shot shape is:

```bash
# On staging, as the authorized operator (root for the supervisor call).
# Set sha, input and result to reviewed absolute values; the files are operator-private.
umask 077
exec 9</var/lib/dazl-staging-deploy/.deploy.lock
flock -n -s 9 || exit 1
workdir="/srv/dazl-staging-releases/${sha}/web"
[ "$(realpath /srv/dazl-staging/current/web)" = "$workdir" ] || exit 1
systemd-run --quiet --wait --pipe --collect \
  --property=User=dazl-staging \
  --property=WorkingDirectory="$workdir" \
  --property=EnvironmentFile=/etc/dazl-staging/env \
  --property=EnvironmentFile=/var/lib/dazl-staging-deploy/release.env \
  --property=EnvironmentFile=/etc/dazl-staging/case-one-signing.env \
  --property=ProtectSystem=strict --property=ProtectHome=yes \
  --property=ReadWritePaths=/var/lib/dazl-staging --property=PrivateTmp=yes \
  --property=NoNewPrivileges=yes --property=RuntimeMaxSec=600 \
  /usr/bin/node --experimental-strip-types "$workdir/scripts/company-first-staging-case-one.mts" "$sha" \
  < "$input" > "$result"
```

This is not a background service/timer and must not be left enabled. A held or
failed attempt does not grant a retry or permit manual ledger changes. Until
the bound entry exists, installing the staging workspace key alone is not
sufficient for the run.
