#!/usr/bin/env python3
"""Disposable six-protocol containment characterization and read regression.

No server address, credentials, or library path can be supplied. All mutations
are confined to /fixture in a newly created, disposable tmpfs server container.
Known server-resolved link exposure is reported, not mislabeled as a passing
containment guarantee. Directory expansion is an enforced regression check.
"""
import argparse
import base64
import concurrent.futures
import http.client
import io
import json
import pathlib
import runpy
import struct
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zipfile
import zlib

helpers = runpy.run_path(str(pathlib.Path(__file__).with_name("network-smoke.py")))
docker = helpers["docker"]
urlopen = helpers["open_respecting_refresh_limit"]
INSIDE = b"I" * 64
OUTSIDE = b"OUTSIDE-SOURCE:" + b"!" * 49
PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM2kAAAAASUVORK5CYII=")
INSIDE_ART, OUTSIDE_ART = PNG + b"INSIDE!", PNG + b"OUTSIDE"


def zip_contents(body):
    """Inspect even local entries of an interrupted ZIP without a central index."""
    contents = []
    position = 0
    while True:
        position = body.find(b"PK\x03\x04", position)
        if position < 0 or len(body) - position < 30:
            return contents
        fields = struct.unpack_from("<4s5H3I2H", body, position)
        method, name_len, extra_len = fields[3], fields[-2], fields[-1]
        start = position + 30 + name_len + extra_len
        name = body[position + 30:position + 30 + name_len].decode("utf-8", "replace")
        if method == 8:
            try:
                content = zlib.decompressobj(-15).decompress(body[start:])
            except zlib.error:
                content = b""
        else:
            content = body[start:start + fields[7]]
        contents.append((name, content))
        position = start


def main(image, report_path):
    network = "gameshelf-containment-" + uuid.uuid4().hex[:10]
    server = app = None
    report = {"scope": "disposable tmpfs only", "protocols": {}}
    fixture_image = "gameshelf:network-test-servers"
    context = pathlib.Path(__file__).resolve().parents[1] / "tests" / "network-fixture"
    import subprocess
    subprocess.run(["docker", "build", "-t", fixture_image, str(context)], check=True)
    docker("network", "create", "--internal", network)
    # The server cannot reach production networks. Only the app's HTTP port is
    # exposed to loopback on a separate temporary bridge.
    http_network = network + "-http"
    docker("network", "create", http_network)
    try:
        server = docker("run", "-d", "--network", network, "--network-alias", "network-fixture",
                        "--tmpfs", "/fixture:rw,mode=0755", "--env", "GAMESHELF_CONTAINMENT_FIXTURE=1",
                        "--security-opt", "no-new-privileges:true", fixture_image)
        # Copy only the fixture's ephemeral public CA into a Docker volume.
        ca_volume = network + "-ca"
        docker("volume", "create", ca_volume)
        certificate = docker("exec", server, "cat", "/tls/server.crt")
        docker("run", "--rm", "--network", "none", "--mount", "type=volume,src=" + ca_volume + ",dst=/ca",
               "--env", "FIXTURE_CA=" + certificate, "--entrypoint", "/bin/sh", fixture_image,
               "-ec", 'printf "%s\\n" "$FIXTURE_CA" > /ca/server.crt; chmod 644 /ca/server.crt')
        app = docker("run", "-d", "--network", http_network, "--read-only", "--cap-drop=ALL",
                     "--security-opt", "no-new-privileges:true", "-p", "127.0.0.1::8080",
                     "--env", "SSL_CERT_FILE=/ca/server.crt", "--mount",
                     "type=volume,src=" + ca_volume + ",dst=/ca,readonly", image)
        docker("network", "connect", network, app)
        base = "http://" + docker("port", app, "8080/tcp").splitlines()[0]

        def request(path, value=None, method=None):
            req = urllib.request.Request(base + path, data=None if value is None else json.dumps(value).encode(),
                                         headers={"Content-Type": "application/json"}, method=method)
            with urlopen(req, timeout=120) as response:
                return json.load(response)

        def observe(path, archive=False, outside=OUTSIDE):
            error = None
            try:
                with urlopen(base + path, timeout=120) as response:
                    status = response.status
                    try:
                        body = response.read()
                    except http.client.IncompleteRead as failure:
                        body, error = failure.partial, type(failure).__name__
            except urllib.error.HTTPError as failure:
                status, body, error = failure.code, failure.read(), "HTTPError"
            except (OSError, urllib.error.URLError, http.client.HTTPException) as failure:
                status, body, error = None, b"", type(failure).__name__
            contents = zip_contents(body) if archive else [("body", body)]
            return {"status": status, "bytes": len(body), "error": error,
                    "outside_content": any(outside in content for _, content in contents)}, body

        for attempt in range(100):
            try:
                setup = request("/api/setup")
                break
            except (OSError, urllib.error.URLError):
                time.sleep(.2)
        else:
            raise AssertionError("fixture application failed to start")

        populate_env = {"INSIDE": INSIDE.decode(), "OUTSIDE": OUTSIDE.decode(),
                        "INSIDE_ART": base64.b64encode(INSIDE_ART).decode(),
                        "OUTSIDE_ART": base64.b64encode(OUTSIDE_ART).decode()}

        def mutate(script):
            args = ["exec"]
            for name, value in populate_env.items():
                args += ["--env", name + "=" + value]
            return docker(*args, server, "sh", "-ec", script)

        def reset(clean_links=True):
            # Constants only, inside the newly created server's tmpfs.
            mutate('''
                rm -rf /fixture/Library /fixture/Outside
                mkdir -p /fixture/Library/Game/Sub /fixture/Outside/Game/Sub /fixture/Outside/Dir
                printf '%s' "$INSIDE" > /fixture/Library/Game/game.bin
                printf '%s' "$INSIDE" > /fixture/Library/Game/Sub/file.bin
                printf '%s' "$OUTSIDE" > /fixture/Outside/game.bin
                printf '%s' "$OUTSIDE" > /fixture/Outside/Game/game.bin
                printf '%s' "$OUTSIDE" > /fixture/Outside/Game/Sub/file.bin
                printf '%s' "$OUTSIDE" > /fixture/Outside/Dir/file.bin
                printf '%s' "$INSIDE_ART" | base64 -d > /fixture/Library/Game/cover.png
                printf '%s' "$OUTSIDE_ART" | base64 -d > /fixture/Outside/cover.png
                cp /fixture/Outside/cover.png /fixture/Outside/Game/cover.png
                mkdir -p /fixture/Outside/Game/LinkedDir
                cp /fixture/Outside/game.bin /fixture/Outside/Game/linked.bin
                cp /fixture/Outside/game.bin /fixture/Outside/Game/LinkedDir/file.bin
                ln -s ../../Outside/game.bin /fixture/Library/Game/linked.bin
                ln -s ../Outside/Game /fixture/Library/LinkedGame
                ln -s ../../Outside/Dir /fixture/Library/Game/LinkedDir
                chmod -R a+rX /fixture
            ''')
            if clean_links:
                mutate('''
                    rm /fixture/Library/Game/linked.bin /fixture/Library/Game/LinkedDir
                    cp /fixture/Library/Game/game.bin /fixture/Library/Game/linked.bin
                    mkdir /fixture/Library/Game/LinkedDir
                    cp /fixture/Library/Game/game.bin /fixture/Library/Game/LinkedDir/file.bin
                ''')

        configured = False
        for protocol, url in [
            ("smb", "smb://network-fixture/games/Library"),
            ("nfs", "nfs://network-fixture/fixture/Library"),
            ("sftp", "sftp://network-fixture:2022/Library"),
            ("webdav", "http://network-fixture:8085/Library"),
            ("ftp", "ftp://network-fixture:2121/Library"),
            ("ftps", "ftps://network-fixture:990/Library"),
        ]:
            reset(clean_links=False)
            source = dict(protocol=protocol, url=url, name=protocol + " containment fixture",
                          username="" if protocol == "nfs" else "reader",
                          password="" if protocol == "nfs" else "fixture-password", uid=10001, gid=10001)
            result = request("/api/network-test", source)
            if result.get("requiresTrust"):
                source["hostKey"] = result["hostKey"]
                request("/api/network-test", source)
            settings = dict(setup["settings"], rootDir="", rootDirs=[], sources=[source], refreshInterval="0")
            request("/api/server-settings" if configured else "/api/setup", settings, "PUT" if configured else "POST")
            configured = True
            games = request("/api/games")
            game = next(item for item in games if item["name"] == "Game")
            game_id = game["id"]
            files = request("/api/game-files/" + game_id)["files"]
            outcomes = report["protocols"][protocol] = {"indexed_games": [item["name"] for item in games],
                                                       "indexed_files": [item["path"] for item in files]}
            file_path = "/api/game-file/" + game_id + "?path="
            outcomes["ordinary_file"], body = observe(file_path + "game.bin")
            assert body == INSIDE, (protocol, outcomes)
            outcomes["static_link"], _ = observe(file_path + "linked.bin")
            outcomes["static_link_directory"], _ = observe(file_path + "LinkedDir/file.bin")
            for bad in ["../Outside/game.bin", "/Outside/game.bin", "Sub/../../Outside/game.bin"]:
                observation, _ = observe(file_path + urllib.parse.quote(bad, safe=""))
                assert observation["status"] in (400, 404) and not observation["outside_content"], observation
            outcomes["lexical_traversal"] = "rejected"

            def workflows(label):
                result = outcomes[label] = {}
                for key, path, archive, marker in [
                    ("file", file_path + "game.bin", False, OUTSIDE),
                    ("artwork", "/covers/" + game_id, False, OUTSIDE_ART),
                    ("zip", "/download/" + game_id, True, OUTSIDE),
                    ("playlist", "/download-playlist?game=" + game_id, True, OUTSIDE),
                ]:
                    # Avoid previous successful cover reads hiding a later link
                    # behind the application's intentionally persistent cache.
                    if key == "artwork":
                        docker("exec", app, "sh", "-ec", "if [ -d /data/network-covers ]; then find /data/network-covers -type f -delete; fi")
                    result[key], _ = observe(path, archive, marker)
                return result

            workflows("static_link_workflows")
            reset()
            docker("exec", server, "sh", "-ec", '''
                rm /fixture/Library/Game/game.bin /fixture/Library/Game/cover.png
                ln -s ../../Outside/game.bin /fixture/Library/Game/game.bin
                ln -s ../../Outside/cover.png /fixture/Library/Game/cover.png
            ''')
            result = workflows("file_replaced_by_link")
            if protocol in ("sftp", "nfs"):
                assert all(not item["outside_content"] for item in result.values()), (protocol, result)
            reset()
            docker("exec", server, "sh", "-ec", '''
                rm -rf /fixture/Library/Game/Sub
                ln -s ../../Outside/Dir /fixture/Library/Game/Sub
            ''')
            outcomes["parent_replaced_by_link"], _ = observe(file_path + "Sub/file.bin")
            if protocol in ("sftp", "nfs"):
                assert not outcomes["parent_replaced_by_link"]["outside_content"], protocol
            reset()
            docker("exec", server, "sh", "-ec", '''
                rm -rf /fixture/Library/Game
                ln -s ../Outside/Game /fixture/Library/Game
            ''')
            result = workflows("game_replaced_by_link")
            if protocol in ("sftp", "nfs"):
                assert all(not item["outside_content"] for item in result.values()), (protocol, result)
            reset()
            # There are no static aliases in this regression: any returned marker
            # must come from expanding the replacement directory itself.
            docker("exec", server, "sh", "-ec", '''
                rm /fixture/Library/Game/game.bin /fixture/Library/Game/cover.png
                mkdir /fixture/Library/Game/game.bin /fixture/Library/Game/cover.png
                cp /fixture/Outside/game.bin /fixture/Library/Game/game.bin/unindexed.bin
                cp /fixture/Outside/cover.png /fixture/Library/Game/cover.png/unindexed.png
            ''')
            result = workflows("file_replaced_by_directory")
            assert all(not item["outside_content"] for item in result.values()), (protocol, result)
            assert result["file"]["bytes"] == 0, (protocol, result)
            assert result["artwork"]["status"] == 404, (protocol, result)
            reset()
            mutate('''
                mkdir -p '/fixture/Library/Active Game'
                dd if=/dev/zero of='/fixture/Library/Active Game/active.bin' bs=1M count=32 2>/dev/null
                chmod -R a+rX '/fixture/Library/Active Game'
            ''')
            refreshed = request("/api/games?forceRefresh=1")
            active_id = next(item["id"] for item in refreshed if item["name"] == "Active Game")
            first_chunk, swapped = threading.Event(), threading.Event()

            def active_read():
                with urlopen(base + "/api/game-file/" + active_id + "?path=active.bin", timeout=120) as response:
                    first = response.read(65536)
                    first_chunk.set()
                    assert swapped.wait(30), "path replacement did not finish"
                    return first + response.read()

            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
                future = executor.submit(active_read)
                assert first_chunk.wait(30), "active download did not start"
                try:
                    mutate('''
                        mv '/fixture/Library/Active Game/active.bin' '/fixture/Library/Active Game/original.bin'
                        ln -s ../../Outside/game.bin '/fixture/Library/Active Game/active.bin'
                    ''')
                finally:
                    swapped.set()
                content = future.result(timeout=120)
            outcomes["path_replaced_after_first_response_chunk"] = {
                "bytes": len(content), "original_content_only": content == bytes(32 << 20),
                "outside_content": OUTSIDE in content,
                "scope": "replacement after HTTP body starts; does not synchronize the remote lookup/open gap"}
            assert content == bytes(32 << 20), (protocol, "open stream changed after path replacement")
            mutate("rm -rf '/fixture/Library/Active Game'")
            print(protocol + ": " + json.dumps(outcomes, sort_keys=True), flush=True)
    finally:
        pathlib.Path(report_path).parent.mkdir(parents=True, exist_ok=True)
        pathlib.Path(report_path).write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        for container in [app, server]:
            if container:
                print(docker("logs", container))
                docker("rm", "-f", "-v", container)
        docker("network", "rm", network)
        docker("network", "rm", http_network)
        if "ca_volume" in locals():
            docker("volume", "rm", ca_volume)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("image")
    parser.add_argument("--report", default="reports/network-containment.json")
    args = parser.parse_args()
    main(args.image, args.report)
