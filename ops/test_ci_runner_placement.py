# CI placement contract: dedicated compute, retained architecture and secret boundaries.
from pathlib import Path
import unittest
import yaml

ROOT = Path(__file__).resolve().parents[1]
CPU_JOBS = {'acceptance-gate.yml': ['no-closing-keywords', 'tag-scope', 'tagged-tests'], 'load-harness.yml': ['harness'], 'never-again-gates.yml': ['never-again'], 'release-gate.yml': ['browser', 'package', 'package-staging', 'migrations'], 'release-preflight.yml': ['fail-closed'], 'session-worker-ci.yml': ['test'], 'static-quality.yml': ['static-quality'], 'web-ci.yml': ['test-sqlite', 'test-postgres'], 'web-preview.yml': ['preview'], 'worker-ci.yml': ['test']}


def workflows():
    return {p.name: yaml.safe_load(p.read_text())
            for p in (ROOT / ".github/workflows").glob("*.yml")}


class CiRunnerPlacement(unittest.TestCase):
    def test_cpu_jobs_use_only_the_dedicated_isolated_runner(self):
        for filename, identifiers in CPU_JOBS.items():
            for identifier in identifiers:
                with self.subTest(workflow=filename, job=identifier):
                    job = workflows()[filename]["jobs"][identifier]
                    self.assertEqual(job["runs-on"],
                                     ["self-hosted", "Linux", "X64", "dazl-ci"])
                    self.assertEqual(job["container"]["image"], "ubuntu:24.04")
                    options = job["container"].get("options", "")
                    for expected in ("--cpus 4", "--memory 6g", "--memory-swap 6g",
                                     "--pids-limit 2048", "--shm-size 1g", "--umask 0022"):
                        self.assertIn(expected, options)
                    for forbidden in ("--privileged", "--network host", "--network=host",
                                      "--ipc host", "--ipc=host", "docker.sock", "/mnt/c"):
                        self.assertNotIn(forbidden, options)
                    self.assertEqual(job["defaults"]["run"]["shell"], "ci-bash {0}")
                    first = job["steps"][0]
                    self.assertEqual(first["name"], "Isolated job prerequisites")
                    self.assertEqual(first["working-directory"], "/")
                    self.assertIn("python3-yaml", first["run"])

    def test_postgres_is_private_and_existing_test_guards_stay_loopback(self):
        job = workflows()["web-ci.yml"]["jobs"]["test-postgres"]
        service = job["services"]["postgres"]
        self.assertFalse(service.get("ports"))
        self.assertEqual(service["image"], "postgres:16")
        self.assertIn("--memory 1g", service["options"])
        self.assertIn("@127.0.0.1:5432/postgres", job["env"]["DAZL_TEST_PG_URL"])
        self.assertEqual(str(job["env"]["DAZL_REQUIRE_PG"]), "1")
        bridges = [step for step in job["steps"]
                   if step.get("name") == "Private loopback PostgreSQL bridge"]
        self.assertEqual(len(bridges), 1)
        self.assertIn("bind=127.0.0.1", bridges[0]["run"])
        self.assertIn("TCP4:postgres:5432", bridges[0]["run"])
        self.assertIn("pg_isready", bridges[0]["run"])
        commands = "\n".join(step.get("run", "") for step in job["steps"])
        self.assertIn("DATABASE_URL=$DAZL_TEST_PG_URL npm run db:migrate", commands)
        self.assertIn("test/leads-read-pg-live.test.ts", commands)

    def test_runtime_dependencies_and_nonroot_bootstrap_are_present(self):
        for filename, identifiers in CPU_JOBS.items():
            for identifier in identifiers:
                with self.subTest(workflow=filename, job=identifier):
                    job = workflows()[filename]["jobs"][identifier]
                    bootstrap = job["steps"][0]
                    self.assertEqual(bootstrap.get("shell"), "bash")
                    for command in ("sqlite3", "rsync", "age"):
                        self.assertIn(command, bootstrap["run"])
                    helpers = [step for step in job["steps"]
                               if step.get("name") == "Install non-root CI command shell"]
                    self.assertEqual(len(helpers), 1)
                    self.assertEqual(helpers[0]["shell"], "bash")
                    self.assertIn("ci-container-bootstrap.sh", helpers[0]["run"])
                    self.assertEqual(job["env"]["NPM_CONFIG_CACHE"], "/tmp/ci-npm-cache")

    def test_preflight_has_node_and_real_browser_before_prod_discovery(self):
        steps = workflows()["release-preflight.yml"]["jobs"]["fail-closed"]["steps"]
        prod = next(i for i, step in enumerate(steps)
                    if "unittest discover -s ops/prod" in step.get("run", ""))
        node = next(i for i, step in enumerate(steps)
                    if step.get("uses") == "actions/setup-node@v4")
        browser = next(i for i, step in enumerate(steps)
                       if step.get("name") == "Preflight real browser prerequisite")
        self.assertLess(node, prod)
        self.assertLess(browser, prod)
        self.assertIn("google-chrome", steps[browser]["run"])

    def test_native_release_builds_and_secret_jobs_do_not_move(self):
        all_workflows = workflows()
        for filename in ("prod-prebuilt.yml", "staging-prebuilt.yml"):
            self.assertEqual(all_workflows[filename]["jobs"]["build"]["runs-on"],
                             "ubuntu-24.04-arm")
        retained = {"acceptance-gate.yml": ["crm-sandbox-preflight", "crm-sandbox-acceptance"],
                    "live-check-gate.yml": ["live-check-gate"],
                    "prod-deploy.yml": ["deploy"],
                    "prod-prebuilt.yml": ["publish"], "staging-prebuilt.yml": ["publish"],
                    "web-ci.yml": ["main-green", "pr-budget"]}
        for filename, identifiers in retained.items():
            for identifier in identifiers:
                with self.subTest(workflow=filename, job=identifier):
                    self.assertEqual(all_workflows[filename]["jobs"][identifier]["runs-on"],
                                     "ubuntu-latest")


if __name__ == "__main__":
    unittest.main()
