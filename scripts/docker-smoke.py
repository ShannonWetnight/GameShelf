#!/usr/bin/env python3
"""Exercise the built container with a temporary, read-only game collection."""
import io
import json
import pathlib
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import zipfile


def docker(*args):
    return subprocess.check_output(["docker", *args], text=True).strip()


def check(image, root, port, expected):
    cid = docker(
        "run", "--detach", "--read-only", "--cap-drop=ALL",
        "--security-opt=no-new-privileges:true",
        "--publish", f"127.0.0.1::{port}",
        "--mount", f"type=bind,src={root},dst=/collection,readonly",
        "--env", "GAMESHELF_ROOT=/collection",
        "--env", f"GAMESHELF_REFRESH_INTERVAL={'1s' if expected else '0'}",
        "--env", f"GAMESHELF_ADDR=:{port}", image,
    )
    try:
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
                assert cover == (root / name / "cover.png").read_bytes()
            else:
                assert cover.startswith(b"\x89PNG")
            archive = zipfile.ZipFile(io.BytesIO(get("/download/" + game["id"])))
            assert archive.testzip() is None
            assert archive.read("game.txt") == b"smoke fixture\n"
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

        if expected:
            assert_preserved_after_failure(root)
            assert_preserved_after_failure(root / "Sample Game")
            print("PASS: failed root/child scans return 503, preserve cache, and recover; scheduled failure preserves cache")
        assert docker("inspect", "--format", "{{.State.Running}}", cid) == "true"
        print(f"PASS: {expected} games, port {port}, static assets, API, covers and ZIP downloads")
    finally:
        print(docker("logs", cid))
        docker("rm", "--force", cid)


if __name__ == "__main__":
    with tempfile.TemporaryDirectory(prefix="gameshelf-smoke-") as temp:
        root = pathlib.Path(temp)
        # The container drops DAC override, so the fixture must be readable
        # across the host runner's UID and the container's UID.
        root.chmod(0o755)
        check(sys.argv[1], root, 8080, 0)
        for name in ("Sample Game", "No Cover"):
            (root / name).mkdir()
            (root / name / "game.txt").write_bytes(b"smoke fixture\n")
        (root / "Sample Game" / "cover.png").write_bytes(
            pathlib.Path("web/placeholder.png").read_bytes()
        )
        check(sys.argv[1], root, 9090, 2)
