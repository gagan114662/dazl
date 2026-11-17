# ops/session-worker: the session worker on the box

`session-worker/` reads LinkedIn (and the other advanced connectors) through a tenant's own saved session for the app. Both apps
have `ADVANCED_WORKER_URL` and `ADVANCED_WORKER_TOKEN` set, but nothing listened on the box, so every session connector failed.
These two files run it.

| file | what it is |
| --- | --- |
| `dazl-session-worker@.service` | systemd template, one instance per environment (`@staging`, `@prod`). User `dazl-session` (no home, no shell), its own env file only, read-only system view, 192 MB cap. |
| `install.sh` | as root: creates the user, puts `session-worker/` at one commit (`git archive`) under `/opt/dazl-session-worker/releases/<sha>`, writes the instance's env file (port, `WORKER_HOST=127.0.0.1`, token), installs and restarts the unit, checks `/health` on 127.0.0.1, and writes the app's two lines to a root-only file. |

Ports: staging 8788, prod 8787 (the app ports are 3200, 3104 and 3105). Memory, measured on Node 22 with the unit's ExecStart:
92 MB resident idle, 106 MB peak after 40 requests.

## On the box (as root)

```
cd /srv/dazl-staging/repo && git fetch -q origin main          # any checkout that has the commit
SHA=<the merged commit>
bash ops/session-worker/install.sh staging "$PWD" "$SHA" --token-from /etc/dazl-staging/env
bash ops/session-worker/install.sh prod    "$PWD" "$SHA" --token-from /home/ubuntu/dazl-pr16-run.env
```

`--token-from` reuses the token the app already has, so only the URL may need to change. Then make each app's
`ADVANCED_WORKER_URL` equal the first line of `/etc/dazl-session-worker/<env>.app-env` (`http://127.0.0.1:8788` for staging,
`http://127.0.0.1:8787` for prod) and restart the app (prod: through the next deploy, which reads the run env).

Updating the worker later is the same command with the new commit; the token is kept. `systemctl status dazl-session-worker@prod`,
`journalctl -u dazl-session-worker@prod`, and `systemctl show -p MemoryPeak dazl-session-worker@prod` after real use.
