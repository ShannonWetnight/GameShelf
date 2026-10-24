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
    mounts = {item["Destination"]: item for item in config["Mounts"]}
    assert not mounts[mount]["RW"], mounts[mount]
    assert mounts["/data"]["Type"] == "volume" and mounts["/data"]["RW"], mounts["/data"]
    docker("exec", cid, "sh", "-ec",
           f"test ! -w /app; test ! -w /app/gameshelf; test ! -w {mount}")


def check(image, root, port, expected, *, user=None, group=None, interval="0",
          mount="/collection", settings=True, refresh_failures=False):
    cid = docker(
        "run", "--detach", *SECURITY,
        *(["--user", user] if user else []),
        *(["--group-add", str(group)] if group else []),
        "--publish", "127.0.0.1::8080",
        "--mount", f"type=bind,src={root},dst={mount},readonly",
        *(["--env", f"GAMESHELF_ROOT={mount}",
           "--env", f"GAMESHELF_REFRESH_INTERVAL={interval}"] if settings else []), image,
    )
    try:
        uid, gid = map(int, (user or "10001:10001").split(":"))
        address = docker("port", cid, "8080/tcp").splitlines()[0]
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
        version = json.loads(get("/api/version"))
        assert version == {
            "version": os.getenv("VERSION", "Development"),
            "channel": os.getenv("CHANNEL", "development"),
        }, version
        assert b"GameShelf" in get("/")
        assert get("/app.js")
        assert get("/styles.css")
        assert len(json.loads(get("/api/games?forceRefresh=1"))) == expected
        if uid == 10001:
            backup_zip = zipfile.ZipFile(io.BytesIO(get("/api/library-backup")))
            assert backup_zip.testzip() is None
            backup = json.loads(backup_zip.read("library-state.json"))
            assert backup["version"] == 1 and isinstance(backup["firstSeen"], dict), backup
            assert len(backup["firstSeen"]) == expected, backup
        else:
            # These custom identities cannot write the image-owned /data volume.
            # The game browser still works; export must report staging failure.
            try:
                get("/api/library-backup")
            except urllib.error.HTTPError as error:
                assert error.code == 503, error.code
                assert not error.headers.get("Content-Disposition"), error.headers
                assert b"Library backup failed" in error.read()
            else:
                raise AssertionError("backup succeeded without writable staging storage")
            print("PASS: unwritable state volume returns a clear backup error without a ZIP")
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
            assert get("/api/game-file/" + game["id"] + "?path=nested%2Fextra.txt") == b"nested fixture\n"
        if uid == 10001 and expected:
            upload = urllib.request.Request(
                base + "/api/covers/" + games[0]["id"],
                data=pathlib.Path("web/placeholder.png").read_bytes(),
                headers={"Content-Type": "image/png"}, method="PUT")
            with urllib.request.urlopen(upload, timeout=5) as response:
                assert response.status == 204
            updated = json.loads(get("/api/games"))
            assert next(game for game in updated if game["id"] == games[0]["id"])["coverSource"] == "uploaded"
            assert any(name.startswith("covers/") for name in
                       zipfile.ZipFile(io.BytesIO(get("/api/library-backup"))).namelist())
            games = updated
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
            # Restore the baseline cache before testing failure preservation.
            restored = json.loads(get("/api/games?forceRefresh=1"))
            assert sorted(restored, key=lambda g: g["id"]) == sorted(
                games, key=lambda g: g["id"]
            ), restored
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
        docker("rm", "--force", "--volumes", cid)


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
        check(image, root, 8080, 2, **options)
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
        cid = docker("run", "--detach", *SECURITY, "--publish", "127.0.0.1::8080",
                     "--env", "GAMESHELF_ROOT=/games",
                     "--mount", f"type=bind,src={root},dst=/games,readonly", image)
        for attempt in range(30):
            try:
                address = docker("port", cid, "8080/tcp").splitlines()[0]
                with urllib.request.urlopen("http://" + address + "/api/setup", timeout=3) as response:
                    assert json.load(response)["required"]
                assert docker("inspect", "--format", "{{.State.Running}}", cid) == "true"
                assert "permission denied" in docker("logs", cid)
                print("PASS: inaccessible explicit library keeps setup available without a restart loop")
                break
            except (OSError, urllib.error.URLError):
                if attempt == 29:
                    raise
                time.sleep(.1)
    finally:
        if cid:
            docker("rm", "--force", "--volumes", cid)
        ownership(image, root, f"{os.getuid()}:{os.getgid()}")
        root.chmod(0o755)

def temporary_ids(image):
    # Actual restricted UID/GID, not a root process that bypasses chmod.
    for seeded in (False, True):
        with tempfile.TemporaryDirectory(prefix="gameshelf-ids-") as temp:
            base_dir = pathlib.Path(temp)
            base_dir.chmod(0o755)
            root, data = base_dir / "games", base_dir / "data"
            root.mkdir(mode=0o755)
            data.mkdir(mode=0o755)
            for name in ("Star Wars", "Star_Wars"):
                (root / name).mkdir(mode=0o755)
                (root / name / "game.txt").write_bytes(name.encode())
            if seeded:
                (data / "library-state.json").write_text(json.dumps({
                    "version": 1, "firstSeen": {},
                    "ids": {"Star Wars": "star-wars", "Absent": "reserved"}}))
                (data / "library-state.json").chmod(0o644)
            data.chmod(0o555)
            cid = None
            try:
                cid = docker("run", "--detach", *SECURITY,
                             "--user", "10002:10003", "--publish", "127.0.0.1::8080",
                             "--mount", f"type=bind,src={root},dst=/games,readonly",
                             "--mount", f"type=bind,src={data},dst=/data",
                             "--env", "GAMESHELF_ROOT=/games", "--env", "GAMESHELF_REFRESH_INTERVAL=0", image)
                def games(refresh=False):
                    for attempt in range(50):
                        try:
                            address = docker("port", cid, "8080/tcp").splitlines()[0]
                            with urllib.request.urlopen("http://" + address + "/api/games" +
                                                        ("?forceRefresh=1" if refresh else ""), timeout=3) as r:
                                return json.load(r)
                        except (OSError, IndexError, urllib.error.URLError):
                            if attempt == 49:
                                raise
                            time.sleep(0.1)
                def ids(rows):
                    assert len(rows) == 2 and len({g["id"] for g in rows}) == 2, rows
                    return {g["name"]: g["id"] for g in rows}
                first = games()
                before = ids(first)
                assert all(g["idPersisted"] == (seeded and g["name"] == "Star Wars") for g in first), first
                if seeded:
                    assert before["Star Wars"] == "star-wars", before
                assert ids(games(True)) == before
                docker("restart", cid)
                assert ids(games()) == before
                # The next scan retries persistence even without folder changes.
                data.chmod(0o700)
                ownership(image, data, "10002:10003")
                recovered = games(True)
                assert ids(recovered) == before and all(g["idPersisted"] for g in recovered), recovered
                docker("exec", cid, "sh", "-ec", "test -s /data/library-state.json")
                docker("restart", cid)
                assert ids(games()) == before
                assert all(g["idPersisted"] for g in games())
                print(f"PASS: restricted UID 10002:10003, seeded={seeded}, temporary IDs, rescan, restart, storage recovery")
            finally:
                if cid:
                    print(docker("logs", cid))
                    docker("rm", "--force", "--volumes", cid)
                ownership(image, data, f"{os.getuid()}:{os.getgid()}")
                data.chmod(0o700)


def first_run(image, root=None):
    cid = docker("run", "--detach", *SECURITY, "--publish", "127.0.0.1::8080",
                 *(["--mount", f"type=bind,src={root},dst=/collection,readonly"] if root else []), image)
    try:
        def request(path, value=None, method=None):
            address = docker("port", cid, "8080/tcp").splitlines()[0]
            req = urllib.request.Request("http://" + address + path,
                data=json.dumps(value).encode() if value is not None else None,
                headers={"Content-Type": "application/json"}, method=method)
            with urllib.request.urlopen(req, timeout=5) as response:
                return json.load(response)
        for attempt in range(40):
            try:
                setup = request("/api/setup")
                break
            except (OSError, urllib.error.URLError):
                if attempt == 39:
                    raise
                time.sleep(.1)
        assert setup["required"] and setup["port"] == 8080, setup
        assert setup["settings"]["rootDir"] == "", setup
        for _ in range(3):
            assert request("/api/games?forceRefresh=1") == []
        assert "scan error" not in docker("logs", cid)
        assert "reading library source /games" not in docker("logs", cid)
        assert docker("inspect", "--format", "{{.RestartCount}}", cid) == "0"
        if root:
            assert "/collection" in setup["mounts"], setup
            assert request("/api/library-folders?path=/collection")["path"] == "/collection"
            value = dict(setup["settings"], rootDir="/etc", rootDirs=["/etc"])
            try:
                request("/api/setup", value)
                raise AssertionError("setup accepted a container system directory")
            except urllib.error.HTTPError as error:
                assert error.code == 400
            value.update(rootDir="/collection", rootDirs=["/collection"], refreshInterval="0")
            assert request("/api/setup", value)["complete"]
            assert not request("/api/setup")["required"]
            assert len(request("/api/games")) == 2
            docker("restart", cid)
            for attempt in range(40):
                try:
                    assert not request("/api/setup")["required"]
                    assert len(request("/api/games")) == 2
                    break
                except (OSError, urllib.error.URLError):
                    if attempt == 39:
                        raise
                    time.sleep(.1)
            value["refreshInterval"] = "24h"
            assert not request("/api/server-settings", value, "PUT")["restartRequired"]
            print("PASS: no environment variables, detected mount, validated setup, immediate index, persisted restart, live schedule")
        else:
            assert setup["mounts"] == [], setup
            print("PASS: no environment variables or game mounts starts quietly on 8080 with setup available")
    finally:
        print(docker("logs", cid))
        docker("rm", "--force", "--volumes", cid)


if __name__ == "__main__":
    image = sys.argv[1]
    assert docker("image", "inspect", "--format", "{{.Config.User}}", image) == "10001:10001"
    first_run(image)
    temporary_ids(image)
    with tempfile.TemporaryDirectory(prefix="gameshelf-smoke-") as temp:
        root = pathlib.Path(temp)
        root.chmod(0o755)
        check(image, root, 8080, 0, mount="/games")
        fixture(root)
        first_run(image, root)
        check(image, root, 8080, 2, interval="100ms", refresh_failures=True)
        restricted_check(image, root, "0:10001", 0o550, 0o440)
        restricted_check(image, root, "10002:10003", 0o500, 0o400, user="10002:10003")
        restricted_check(image, root, "0:10004", 0o550, 0o440,
                         user="10002:10003", group=10004)
        denied_root(image, root)

