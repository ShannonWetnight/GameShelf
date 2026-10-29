"""Independent lanes are bounded, retained on failure, and required for success."""
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('verify', Path(__file__).parents[1] / 'scripts/verify.py')
verify = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verify)


class VerifyRunnerTests(unittest.TestCase):
    def setUp(self):
        # Simulated failures must not appear in the real Actions summary.
        env = patch.dict(os.environ, GITHUB_STEP_SUMMARY='')
        env.start()
        self.addCleanup(env.stop)

    def test_failed_lane_does_not_skip_other_gates_and_every_result_is_recorded(self):
        with tempfile.TemporaryDirectory() as directory:
            reports = Path(directory)
            commands = {'fail': [sys.executable, '-c', 'print("failed gate");raise SystemExit(1)'],
                        'pass': [sys.executable, '-c', 'print("passed gate")'],
                        'scan': [sys.executable, '-c', 'print("scan still ran")']}
            self.assertFalse(verify.run_lanes(commands, reports, workers=2))
            data = json.loads((reports / 'verification-timings.json').read_text())
            self.assertEqual([item['exit_code'] for item in data], [1, 0, 0])
            self.assertIn('scan still ran', (reports / 'scan-checks.log').read_text())

    def test_success_requires_all_lanes(self):
        with tempfile.TemporaryDirectory() as directory:
            self.assertTrue(verify.run_lanes({'one': [sys.executable, '-c', 'print("ok")']}, Path(directory)))

    def test_missing_command_is_a_recorded_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            reports = Path(directory)
            self.assertFalse(verify.run_lanes({'missing': [str(reports / 'no-such-command')]}, reports))
            self.assertEqual(json.loads((reports / 'verification-timings.json').read_text())[0]['exit_code'], 127)

    def test_independent_checks_overlap_but_never_exceed_two_processes(self):
        with tempfile.TemporaryDirectory() as directory:
            reports = Path(directory)
            events = reports / 'events'
            code = ('import os,sys,time;'
                    'f=os.open(sys.argv[1],os.O_WRONLY|os.O_CREAT|os.O_APPEND,0o600);'
                    'os.write(f,b"start\\n");time.sleep(.2);os.write(f,b"end\\n");os.close(f)')
            commands = {str(n): [sys.executable, '-c', code, str(events)] for n in range(4)}
            self.assertTrue(verify.run_lanes(commands, reports))
            active = maximum = 0
            for event in events.read_text().splitlines():
                active += 1 if event == 'start' else -1
                maximum = max(active, maximum)
            self.assertEqual(active, 0)
            self.assertEqual(maximum, 2)


if __name__ == '__main__':
    unittest.main()
