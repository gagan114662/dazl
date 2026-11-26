# PC lane for pull-request shards

Pull-request test shards can run on the isolated `dazl-ci` self-hosted runner (a dedicated WSL2 distro on the
Kabir PC) instead of GitHub-hosted `ubuntu-latest`, so hosted concurrency stays free for main, merge_group,
deploy and release work.

## Routing

Repo variable `PR_CI_RUNNER` selects the runner for these PR-only jobs:

- acceptance-gate: `no-closing-keywords`, `tag-scope`, `tagged-tests`
- release-gate: `browser`
- web-ci: `sqlite-shard` (x4), `postgres-shard` (x4)

The PC lane is used only when the event is `pull_request`, the PR head is in this repository (never a fork)
and `PR_CI_RUNNER` is `dazl-ci`. Otherwise every job runs exactly as before on `ubuntu-latest`. Push, main,
merge_group, workflow_dispatch, deploy and release jobs never read the variable. Unset it, or set it to
`ubuntu-latest`, to move the shards back to GitHub-hosted.

The older `PR_RUNNER` variable is read only by PR heads that predate this change. It stays `ubuntu-latest`,
so those heads (which have no job container) never land on the container-only PC runner.

## What changes on the PC lane

- Each job runs in a disposable `ubuntu:24.04` rootless-Docker job container with explicit bounds
  (`--cpus 4 --memory 6g --pids-limit 2048 --shm-size 1g --umask 0022`). The runner refuses
  containerless jobs (`ACTIONS_RUNNER_REQUIRE_JOB_CONTAINER=true`).
- The `PC lane ...` steps install the tools the hosted image provides, then
  `.github/scripts/ci-container-bootstrap.sh` creates a non-root `ci` user (uid 1001). Every original
  command runs as that user through `ci-bash`, so permission-sensitive tests still run instead of
  passing as root.
- PostgreSQL is a private service container with no published host port. All WSL distros share one
  network namespace, so a published port would collide. A loopback-only socat bridge inside the job
  container keeps `DAZL_TEST_PG_URL` at `127.0.0.1:5432`.
- Job names, required check names, test commands, Node versions, timeouts, conditions and every
  original step are unchanged. These steps are skipped on GitHub-hosted runners.

## Host boundary (operator side, not in this repo)

The distro has no Windows automount or interop. A root-owned nftables egress boundary blocks the CI uid
and its subuids from loopback, LAN, link-local and CGNAT addresses; only DNS and TCP 80/443 are allowed.
The listener is one-shot. After each job the distro is restored from a verified snapshot before it
accepts another job.
