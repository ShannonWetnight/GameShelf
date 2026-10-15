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
        "--env", "GAMESHELF_REFRESH_INTERVAL=0",
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
        assert docker("inspect", "--format", "{{.State.Running}}", cid) == "true"
        print(f"PASS: {expected} games, port {port}, static assets, API, covers and ZIP downloads")
    finally:
        print(docker("logs", cid))
        docker("rm", "--force", cid)


if __name__ == "__main__":
    with tempfile.TemporaryDirectory(prefix="gameshelf-smoke-") as temp:
        root = pathlib.Path(temp)
        check(sys.argv[1], root, 8080, 0)
        for name in ("Sample Game", "No Cover"):
            (root / name).mkdir()
            (root / name / "game.txt").write_bytes(b"smoke fixture\n")
        (root / "Sample Game" / "cover.png").write_bytes(
            pathlib.Path("web/placeholder.png").read_bytes()
        )
        check(sys.argv[1], root, 9090, 2)
