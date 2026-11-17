# Dedicated PC CI runner

CPU validation jobs select `[self-hosted, Linux, X64, dazl-ci]`, never a generic self-hosted runner. Each job runs in its own Ubuntu24.04 rootless Docker container. Job names, test commands, Node versions, required checks, triggers, conditions, and existing timeout budgets are unchanged. The `full-suite-ci` label still forces the complete PR suites; main still runs the complete SQLite and PostgreSQL suites.

## Isolation and resource bounds

The dedicated disposable WSL distro has no Windows automount, Windows interop, owner credentials, host Docker socket, or shared GUI mounts. Its root-owned egress boundary covers the CI user and subordinate UID range; other users are excluded. Private host/LAN/link-local/overlay endpoints remain blocked. The rootless Docker user slice is bounded separately from the runner service: a runner memory limit alone would not cap its containers. Every job has private networking and shared memory, explicit CPU/RAM/PID limits, and no host ports or privileged/host-network options.

PostgreSQL is a private service container with no published host port. A loopback-only socat bridge INSIDE the job container forwards to the private service alias and must pass pg_isready. Existing loopback-only PG/network/migration guards stay unchanged; the real full-suite PG tests, double migration and live regenerated-schema contract still run.

## Deliberately retained jobs

ARM-native production/staging dependency artifacts remain on the existing ARM hosted runners, preserving native module architecture. Production SSH deployment, sandbox-secret jobs, release publishing and lightweight status/issue controllers retain their existing hosted boundaries. Their presence on GitHub is intentional and is not CPU-test execution on the PC.

## Evidence and release gate

An online listener or routing file is NOT successful migration. Verify each executed job at the exact commit/run/attempt through the GitHub jobs API: intended runner identity and labels, successful original checks, and test totals. Conditional skipped jobs are not executed passes. Require clean reset and successful fresh admission between jobs. No merge/protection bypass, test reduction, paid capacity, GPU benefit or speed improvement is implied. Speed claims require separately collected comparable timing evidence.

The protected migration PR must remain unmerged until the actual routed suites and required checks pass, with reset, browser and service-container behavior verified. The host baseline and detailed receipts remain in private operator evidence storage, not in this repository.

Job-container umask is explicitly0022. Docker exec was observed to default to0000 despite restrictive service settings; verified checkout modes must therefore accompany the host settings.

Original test/build shell commands execute as the non-root ci user through the job-local ci-bash shell. Only prerequisite setup and JavaScript actions retain the standard root container context. Explicit source/cache ownership and command-file handoff preserve access without making source files group-writable. rsync, sqlite3 and age are installed before tests; preflight receives Node22 and real Chrome before ops/prod discovery. This preserves permission-sensitive and browser/restore coverage instead of accepting root/tool-related skips.
