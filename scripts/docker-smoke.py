#!/usr/bin/env python3
"""Exercise the built container with a temporary, read-only game collection."""
import io
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import zipfile


def docker(*args):
    return subprocess.check_output(["docker", *args], text=True, stderr=subprocess.STDOUT).strip()


SECURITY = ("--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges:true")


def identity(cid, uid, gid, mount):
    # Inspect PID 1, not just an exec shell or image metadata.
    status = dict(line.split(":", 1) for line in
                  docker("exec", cid, "cat", "/proc/1/status").splitlines() if ":" in line)
    assert status["Uid"].split() == [str(uid)] * 4, status
    assert status["Gid"].split() == [str(gid)] * 4, status
    assert uid != 0 and gid != 0
    assert "0" not in status["Groups"].split(), status
    assert int(status["CapEff"], 16) == 0, status
    assert status["NoNewPrivs"].strip() == "1", status
    config = json.loads(docker("inspect", cid))[0]
    assert config["HostConfig"]["ReadonlyRootfs"]
    assert all(not mount["RW"] for mount in config["Mounts"])
    docker("exec", cid, "sh", "-ec",
           f"test ! -w /app; test ! -w /app/gameshelf; test ! -w {mount}")


def check(image, root, port, expected, *, user=None, group=None, interval="0",
          mount="/collection", settings=True, refresh_failures=False):
    cid = docker(
        "run", "--detach", *SECURITY,
        *(["--user", user] if user else []),
        *(["--group-add", str(group)] if group else []),
        "--publish", f"127.0.0.1::{port}",
        "--mount", f"type=bind,src={root},dst={mount},readonly",
        *(["--env", f"GAMESHELF_ROOT={mount}",
           "--env", f"GAMESHELF_REFRESH_INTERVAL={interval}",
           "--env", f"GAMESHELF_ADDR=:{port}"] if settings else []), image,
    )
    try:
        uid, gid = map(int, (user or "10001:10001").split(":"))
        address = docker("port", cid, f"{port}/tcp").splitlines()[0]
        base = "http://" + address

        def get(path):
            with urllib.request.urlopen(base + path, timeout=5) as response:
                assert response.status == 200
                return response.read()

        for attempt in range(30):
            try:
                games = json.loads(get("/api/games"))
                break
            except (OSError, urllib.error.URLError):
                if docker("inspect", "--format", "{{.State.Running}}", cid) != "true":
                    raise RuntimeError("container exited before becoming ready")
                if attempt == 29:
                    raise
                time.sleep(1)
        identity(cid, uid, gid, mount)
        if group:
            assert str(group) in docker("exec", cid, "id", "-G").split()
        assert len(games) == expected, games
        assert b"GameShelf" in get("/")
        assert get("/app.js")
        assert get("/styles.css")
        assert len(json.loads(get("/api/games?forceRefresh=1"))) == expected
        for game in games:
            name = game["name"]
            assert name in {"Sample Game", "No Cover"}, game
            assert game["hasCover"] == (name == "Sample Game"), game
            assert game["sizeBytes"] > 0, game
            cover = get("/covers/" + game["id"])
            if name == "Sample Game":
                assert cover == pathlib.Path("web/placeholder.png").read_bytes()
            else:
                assert cover.startswith(b"\x89PNG")
            archive = zipfile.ZipFile(io.BytesIO(get("/download/" + game["id"])))
            assert archive.testzip() is None
            assert archive.read("game.txt") == b"smoke fixture\n"
            assert archive.read("nested/extra.txt") == b"nested fixture\n"
        if interval == "100ms":
            # A host-side addition must be discovered by the configured timer.
            (root / "Added Later").mkdir(mode=0o755)
            try:
                for attempt in range(30):
                    if len(json.loads(get("/api/games"))) == expected + 1:
                        break
                    time.sleep(0.1)
                else:
                    raise AssertionError("scheduled rescan did not discover the new game")
            finally:
                (root / "Added Later").rmdir()
        try:
            get("/download/not-a-game")
            raise AssertionError("missing game returned success")
        except urllib.error.HTTPError as error:
            assert error.code == 404
        def assert_preserved_after_failure(blocked):
            mode = blocked.stat().st_mode & 0o777
            blocked.chmod(0)
            try:
                try:
                    get("/api/games?forceRefresh=1")
                    raise AssertionError("failed scan returned success")
                except urllib.error.HTTPError as error:
                    assert error.code == 503, error.code
                    assert b"Unable to refresh game library" in error.read()
                if blocked == root:
                    # Confirm a scheduled scan has also failed before reading cache.
                    for attempt in range(30):
                        if "periodic scan error:" in subprocess.check_output(
                            ["docker", "logs", cid], text=True, stderr=subprocess.STDOUT
                        ):
                            break
                        if attempt == 29:
                            raise AssertionError("scheduled scan did not report failure")
                        time.sleep(0.2)
                cached = json.loads(get("/api/games"))
                assert sorted(cached, key=lambda g: g["id"]) == sorted(
                    games, key=lambda g: g["id"]
                ), cached
            finally:
                blocked.chmod(mode)
            recovered = json.loads(get("/api/games?forceRefresh=1"))
            assert sorted(recovered, key=lambda g: g["id"]) == sorted(
                games, key=lambda g: g["id"]
            ), recovered

        # These checks chmod fixtures and require a running rescan timer.
        # Restricted ownership scenarios exercise access without changing modes.
        if refresh_failures:
            assert interval != "0" and settings
            assert_preserved_after_failure(root)
            assert_preserved_after_failure(root / "Sample Game")
            print("PASS: failed root/child scans return 503, preserve cache, and recover; scheduled failure preserves cache")
        assert docker("inspect", "--format", "{{.State.Running}}", cid) == "true"
        print(f"PASS: UID/GID {uid}:{gid}, {expected} games, port {port}, "
              "static assets, API, covers, nested ZIP downloads and security restrictions")
    finally:
        print(docker("logs", cid))
        docker("rm", "--force", cid)


def fixture(root):
    root.chmod(0o755)
    for name in ("Sample Game", "No Cover"):
        (root / name / "nested").mkdir(parents=True)
        (root / name / "game.txt").write_bytes(b"smoke fixture\n")
        (root / name / "nested" / "extra.txt").write_bytes(b"nested fixture\n")
    (root / "Sample Game" / "cover.png").write_bytes(
        pathlib.Path("web/placeholder.png").read_bytes())
    for path in root.rglob("*"):
        path.chmod(0o755 if path.is_dir() else 0o644)


def ownership(image, root, owner):
    # Only this temporary fixture is writable by the setup helper. The actual
    # application always runs non-root with read-only mounts and no capabilities.
    docker("run", "--rm", "--user", "0:0", "--cap-drop=ALL", "--cap-add=CHOWN", "--cap-add=DAC_OVERRIDE",
           "--security-opt=no-new-privileges:true", "--read-only",
           "--mount", f"type=bind,src={root},dst=/fixture",
           "--entrypoint", "chown", image, "-R", owner, "/fixture")


def restricted_check(image, root, owner, dmode, fmode, **options):
    # Set modes before changing owner so this also works on non-root CI runners.
    paths = [root, *root.rglob("*")]
    for path in paths:
        path.chmod(dmode if path.is_dir() else fmode)
    try:
        ownership(image, root, owner)
        check(image, root, 9090, 2, **options)
    finally:
        # Restore the runner's ownership before TemporaryDirectory cleanup.
        ownership(image, root, f"{os.getuid()}:{os.getgid()}")
        for path in paths:
            path.chmod(0o755 if path.is_dir() else 0o644)


def denied_root(image, root):
    root.chmod(0o700)
    ownership(image, root, "0:0")
    cid = None
    try:
        cid = docker("run", "--detach", *SECURITY,
                     "--mount", f"type=bind,src={root},dst=/games,readonly", image)
        for attempt in range(30):
            state = json.loads(docker("inspect", cid))[0]["State"]
            if not state["Running"]:
                assert state["ExitCode"] != 0, state
                assert "permission denied" in docker("logs", cid), state
                print("PASS: inaccessible root fails startup with permission denied")
                break
            time.sleep(0.1)
        else:
            raise AssertionError("inaccessible root unexpectedly started")
    finally:
        if cid:
            docker("rm", "--force", cid)
        ownership(image, root, f"{os.getuid()}:{os.getgid()}")
        root.chmod(0o755)


if __name__ == "__main__":
    image = sys.argv[1]
    assert docker("image", "inspect", "--format", "{{.Config.User}}", image) == "10001:10001"
    with tempfile.TemporaryDirectory(prefix="gameshelf-smoke-") as temp:
        root = pathlib.Path(temp)
        root.chmod(0o755)
        check(image, root, 8080, 0, mount="/games", settings=False)
        fixture(root)
        check(image, root, 9090, 2, interval="100ms", refresh_failures=True)
        restricted_check(image, root, "0:10001", 0o550, 0o440)
        restricted_check(image, root, "10002:10003", 0o500, 0o400, user="10002:10003")
        restricted_check(image, root, "0:10004", 0o550, 0o440,
                         user="10002:10003", group=10004)
        denied_root(image, root)
