#!/usr/bin/env python3
"""Run independent verification lanes with bounded concurrency and complete results."""
import concurrent.futures
import json
import os
from pathlib import Path
import signal
import subprocess
import threading
import time

LANES = ('unit', 'browser', 'containers', 'network', 'smb', 'scan')


def run_lanes(commands, reports, workers=2):
    reports.mkdir(exist_ok=True)
    active, lock, stop = set(), threading.Lock(), threading.Event()

    def cancel(_signum, _frame):
        stop.set()
        with lock:
            for process in active:
                if os.name == 'posix':
                    try:
                        os.killpg(process.pid, signal.SIGTERM)
                    except ProcessLookupError:
                        pass
                else:
                    process.terminate()

    previous = {sig: signal.signal(sig, cancel) for sig in (signal.SIGTERM, signal.SIGINT)}

    def lane(name, command):
        started = time.monotonic()
        log = reports / f'{name}-checks.log'
        if stop.is_set():
            return {'name': name, 'exit_code': -1, 'seconds': 0, 'log': log.name}
        print(f'Starting {name} verification.', flush=True)
        with log.open('w') as output:
            try:
                process = subprocess.Popen(command, stdout=output, stderr=subprocess.STDOUT,
                                           start_new_session=os.name == 'posix')
                with lock:
                    active.add(process)
                    if stop.is_set():
                        process.terminate()
                code = process.wait()
                with lock:
                    active.remove(process)
            except OSError as error:
                output.write(str(error) + '\n')
                code = 127
        elapsed = round(time.monotonic() - started, 2)
        print(f'{name}: {"PASS" if code == 0 else "FAIL"} ({elapsed}s), log: {log}', flush=True)
        if code:
            print('\n'.join(log.read_text(errors='replace').splitlines()[-60:]), flush=True)
        return {'name': name, 'exit_code': code, 'seconds': elapsed, 'log': log.name}

    try:
        with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
            futures = [pool.submit(lane, name, command) for name, command in commands.items()]
            results = [future.result() for future in futures]
    finally:
        for sig, handler in previous.items():
            signal.signal(sig, handler)
    (reports / 'verification-timings.json').write_text(json.dumps(results, indent=2) + '\n')
    if summary := os.environ.get('GITHUB_STEP_SUMMARY'):
        with open(summary, 'a') as output:
            output.write('\n| Verification | Result | Seconds |\n|---|---|---:|\n')
            for item in results:
                output.write(f"| {item['name']} | {'Pass' if item['exit_code'] == 0 else 'Fail'} | {item['seconds']} |\n")
    return not stop.is_set() and all(item['exit_code'] == 0 for item in results)


if __name__ == '__main__':
    raise SystemExit(0 if run_lanes({name: ['bash', 'scripts/verify-lane.sh', name] for name in LANES},
                                   Path('reports')) else 1)
