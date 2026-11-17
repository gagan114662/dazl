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
                                     "--pids-limit 2048", "--shm-size 1g"):
                        self.assertIn(expected, options)
                    for forbidden in ("--privileged", "--network host", "--network=host",
                                      "--ipc host", "--ipc=host", "docker.sock", "/mnt/c"):
                        self.assertNotIn(forbidden, options)
                    self.assertEqual(job["defaults"]["run"]["shell"], "bash")
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
