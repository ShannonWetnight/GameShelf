#!/usr/bin/env python3
"""Actual SMB/NFS/SFTP/WebDAV/FTP/FTPS servers; the app remains unprivileged."""
import base64
import io
import json
import pathlib
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zipfile


def open_respecting_refresh_limit(request, *args, **kwargs):
    """Honor the app's discovery cooldown; do not retry unrelated rate limits."""
    url = request.full_url if isinstance(request, urllib.request.Request) else str(request)
    for attempt in range(3):
        try:
            return urllib.request.urlopen(request, *args, **kwargs)
        except urllib.error.HTTPError as error:
            if error.code != 429 or "forceRefresh" not in url or attempt == 2:
                raise
            time.sleep(min(11, max(1, int(error.headers.get("Retry-After", "10")))))


def docker(*args):
    return subprocess.check_output(["docker", *args], text=True, stderr=subprocess.STDOUT).strip()


def main(image):
    fixture_image = "gameshelf:network-test-servers"
    context = pathlib.Path(__file__).resolve().parents[1] / "tests" / "network-fixture"
    subprocess.run(["docker", "build", "--tag", fixture_image, str(context)], check=True)
    network = "gameshelf-net-test-" + uuid.uuid4().hex[:10]
    server = app = None
    docker("network", "create", network)
    with tempfile.TemporaryDirectory(prefix="gameshelf-network-") as temporary:
        root = pathlib.Path(temporary)
        root.chmod(0o755)
        library = root / "library"
        game = library / "Network Game"
        game.mkdir(parents=True)
        payload = b"network-game-payload\n"
        (game / "game.bin").write_bytes(payload)
        cover = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM2kAAAAASUVORK5CYII=")
        (game / "cover.png").write_bytes(cover)
        (library / "Escape").symlink_to("/private.txt")
        for path in [library, game]:
            path.chmod(0o755)
        for path in game.iterdir():
            path.chmod(0o644)
        try:
            server = docker("run", "--detach", "--network", network, "--network-alias", "network-fixture",
                "--security-opt", "no-new-privileges:true",
                "--mount", f"type=bind,src={library},dst=/fixture,readonly", fixture_image)
            certificate = root / "server.crt"
            docker("cp", f"{server}:/tls/server.crt", str(certificate))
            certificate.chmod(0o644)
            app = docker("run", "--detach", "--network", network, "--read-only", "--cap-drop=ALL",
                "--security-opt", "no-new-privileges:true", "--publish", "127.0.0.1::8080",
                "--env", "SSL_CERT_FILE=/trusted-network-ca.pem",
                "--mount", f"type=bind,src={certificate},dst=/trusted-network-ca.pem,readonly", image)
            address = docker("port", app, "8080/tcp").splitlines()[0]
            base = "http://" + address

            def request(path, value=None, method=None, headers=None, raw=False):
                req = urllib.request.Request(base + path, data=json.dumps(value).encode() if value is not None else None,
                    headers={"Content-Type": "application/json", **(headers or {})}, method=method)
                with open_respecting_refresh_limit(req, timeout=120) as response:
                    content = response.read()
                    return (response.status, content) if raw else json.loads(content)

            for attempt in range(60):
                try:
                    setup = request("/api/setup")
                    break
                except (OSError, urllib.error.URLError):
                    if attempt == 59:
                        raise
                    time.sleep(.2)
            assert setup["required"] and setup["mounts"] == [], setup
            assert docker("exec", app, "id", "-u") == "10001"
            configured = False
            protocols = [
                ("smb", "smb://network-fixture/games"),
                ("nfs", "nfs://network-fixture/fixture"),
                ("sftp", "sftp://network-fixture:2022/"),
                ("webdav", "http://network-fixture:8085/"),
                ("ftp", "ftp://network-fixture:2121/"),
                ("ftps", "ftps://network-fixture:990/"),
            ]
            for protocol, url in protocols:
                source = dict(id="", name=protocol.upper() + " fixture", protocol=protocol, url=url,
                    username="" if protocol == "nfs" else "reader", password="" if protocol == "nfs" else "fixture-password",
                    nfsVersion=0, uid=10001, gid=10001)
                for attempt in range(3):
                    try:
                        result = request("/api/network-test", source)
                        if result.get("requiresTrust"):
                            source["hostKey"] = result["hostKey"]
                            result = request("/api/network-test", source)
                        source.update(result["source"])
                        break
                    except urllib.error.HTTPError as error:
                        message = error.read().decode()
                        if attempt == 2:
                            if protocol == "ftps":
                                # These are isolated fixture credentials, never user secrets.
                                obscured = docker("exec", app, "rclone", "obscure", "fixture-password")
                                args = ["docker", "exec"]
                                for key, value in dict(TYPE="ftp", HOST="network-fixture", PORT="990", USER="reader", PASS=obscured, TLS="true").items():
                                    args += ["--env", "RCLONE_CONFIG_DIAG_" + key + "=" + value]
                                args += [app, "rclone", "--config", "/dev/null", "--log-level", "ERROR", "--timeout", "8s", "--retries", "1", "lsjson", "diag:/"]
                                diagnostic = subprocess.run(args, text=True, capture_output=True, timeout=20)
                                print(diagnostic.stderr[-8000:])
                            raise AssertionError(f"{protocol} connection test: {message}") from error
                        time.sleep(.3)
                # Test replies intentionally contain no password; retain the test input.
                source["password"] = "" if protocol == "nfs" else "fixture-password"
                settings = dict(setup["settings"], rootDir="", rootDirs=[], sources=[source], refreshInterval="0")
                saved = request("/api/server-settings" if configured else "/api/setup", settings, "PUT" if configured else "POST")
                configured = True
                assert "fixture-password" not in json.dumps(saved), saved
                games = request("/api/games")
                assert len(games) == 1, (protocol, games)
                selected = games[0]
                assert selected["name"] == "Network Game" and selected["fileCount"] == 2, selected
                assert selected["sizeBytes"] == len(payload) + len(cover), selected
                status, downloaded = request("/download/" + selected["id"], raw=True)
                archive = zipfile.ZipFile(io.BytesIO(downloaded))
                assert status == 200 and archive.read("game.bin") == payload, protocol
                assert archive.read("cover.png") == cover, protocol
                status, picture = request("/covers/" + selected["id"], raw=True)
                assert status == 200 and picture == cover, protocol
                status, part = request("/api/game-file/" + selected["id"] + "?path=game.bin", headers={"Range": "bytes=3-8"}, raw=True)
                assert status == 206 and part == payload[3:9], protocol
                _, playlist = request("/download-playlist?game=" + selected["id"], raw=True)
                assert zipfile.ZipFile(io.BytesIO(playlist)).read(selected["id"] + "/game.bin") == payload, protocol
                if protocol != "nfs":
                    saved_file = docker("exec", app, "cat", "/data/server-settings.json")
                    assert "fixture-password" not in saved_file and "passwordCipher" in saved_file
                print(f"PASS: direct {protocol}, no game mount, connection test, index, covers, ZIP, range, Playlist, private credentials")
            docker("restart", app)
            base = "http://" + docker("port", app, "8080/tcp").splitlines()[0]
            for attempt in range(60):
                try:
                    assert not request("/api/setup")["required"]
                    if len(request("/api/games")) == 1:
                        break
                except (OSError, urllib.error.URLError):
                    pass
                time.sleep(.2)
            else:
                raise AssertionError("network library did not recover after restart")
            print("PASS: network-only library and encrypted credentials survive a container restart")

            # A cold start with the file server disconnected must restore only
            # metadata, never advertise downloadable offline game content.
            selected = request("/api/games")[0]
            game_id, added_at = selected["id"], selected["addedAt"]
            request("/api/game-title/" + game_id, {"title": "Offline favorite"}, "PUT")
            request("/api/favorite/" + game_id, {"favorite": True}, "PUT")
            docker("network", "disconnect", network, server)
            offline = request("/api/games?forceRefresh=1")
            assert len(offline) == 1 and offline[0]["unavailable"], offline
            docker("restart", app)
            base = "http://" + docker("port", app, "8080/tcp").splitlines()[0]
            deadline = time.monotonic() + 150
            while time.monotonic() < deadline:
                try:
                    state = request("/api/source-status")
                    offline = request("/api/games")
                    if not state["busy"] and offline:
                        break
                except (OSError, urllib.error.URLError):
                    pass
                time.sleep(.3)
            else:
                raise AssertionError("offline catalog did not survive restart")
            assert len(offline) == 1, offline
            cached = offline[0]
            assert cached["id"] == game_id and cached["idPersisted"] and cached["unavailable"], cached
            assert cached["name"] == "Offline favorite" and cached["favorite"] and cached["addedAt"] == added_at, cached
            assert cached["fileCount"] == 2 and cached["sizeBytes"] == len(payload) + len(cover), cached
            assert any(source["state"] == "offline" for source in state["sources"]), state
            files = request("/api/game-files/" + game_id)
            assert files["unavailable"] and {item["path"] for item in files["files"]} == {"game.bin", "cover.png"}, files
            for path in ["/download/" + game_id, "/api/game-file/" + game_id + "?path=game.bin", "/download-playlist?game=" + game_id]:
                try:
                    request(path, raw=True)
                    raise AssertionError("offline download succeeded: " + path)
                except urllib.error.HTTPError as error:
                    assert error.code == 503 and b"offline" in error.read(), path
            _, picture = request("/covers/" + game_id, raw=True)
            assert picture == cover, "previously cached cover lost its association"
            snapshot = docker("exec", app, "cat", "/data/network-index.json")
            for secret in ["fixture-password", "passwordCipher", "username", "ftps://"]:
                assert secret not in snapshot, "cached index contains connection material"
            print("PASS: disconnected source, cold restart, cached catalog/metadata/cover, offline notice, blocked downloads")

            # The same fixture returns with a changed directory listing. A live
            # scan must replace cached files, including additions and removals.
            (game / "game.bin").unlink()
            replacement = b"replacement-content"
            (game / "replacement.bin").write_bytes(replacement)
            (game / "replacement.bin").chmod(0o644)
            second = library / "Second Game"
            second.mkdir(mode=0o755)
            (second / "second.bin").write_bytes(b"second")
            (second / "second.bin").chmod(0o644)
            docker("network", "connect", "--alias", "network-fixture", network, server)
            recovered = request("/api/games?forceRefresh=1")
            assert len(recovered) == 2 and all(not item.get("unavailable") for item in recovered), recovered
            original = next(item for item in recovered if item["id"] == game_id)
            assert original["favorite"] and original["name"] == "Offline favorite" and original["addedAt"] == added_at
            assert original["sizeBytes"] == len(replacement) + len(cover), original
            files = request("/api/game-files/" + game_id)
            assert {item["path"] for item in files["files"]} == {"replacement.bin", "cover.png"}, files
            _, downloaded = request("/download/" + game_id, raw=True)
            assert zipfile.ZipFile(io.BytesIO(downloaded)).read("replacement.bin") == replacement
            for child in game.iterdir():
                child.unlink()
            game.rmdir()
            remaining = request("/api/games?forceRefresh=1")
            assert len(remaining) == 1 and remaining[0]["name"] == "Second Game", remaining
            docker("network", "disconnect", network, server)
            docker("restart", app)
            base = "http://" + docker("port", app, "8080/tcp").splitlines()[0]
            deadline = time.monotonic() + 150
            while time.monotonic() < deadline:
                try:
                    state = request("/api/source-status")
                    remaining = request("/api/games")
                    if not state["busy"] and remaining:
                        break
                except (OSError, urllib.error.URLError):
                    pass
                time.sleep(.3)
            else:
                raise AssertionError("replacement snapshot did not load")
            assert len(remaining) == 1 and remaining[0]["name"] == "Second Game" and remaining[0]["unavailable"], remaining
            print("PASS: reconnect, fresh file/index replacement, removed game stays absent on the next offline restart")
        finally:
            for cid in [app, server]:
                if cid:
                    print(docker("logs", cid))
                    if cid == server:
                        diagnostic = subprocess.run(["docker", "exec", cid, "cat", "/var/log/vsftpd.log"], text=True, capture_output=True)
                        if diagnostic.returncode == 0:
                            print(diagnostic.stdout)
                    docker("rm", "--force", "--volumes", cid)
            docker("network", "rm", network)


if __name__ == "__main__":
    main(sys.argv[1])
