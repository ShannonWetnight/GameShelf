#!/usr/bin/env python3
"""Prove read-only app behavior with genuinely writable, disposable SMB data.

Accepts an application image, never a server address, share path or credentials.
All writes below are independent permission probes inside a fresh fixture.
"""
import base64
import importlib.util
import io
import json
import pathlib
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zipfile

# Reuse the discovery cooldown handling from the six-protocol integration suite.
module = importlib.util.spec_from_file_location('network_smoke', pathlib.Path(__file__).with_name('network-smoke.py'))
network_smoke = importlib.util.module_from_spec(module)
module.loader.exec_module(network_smoke)
docker = network_smoke.docker


def main(image):
    repo = pathlib.Path(__file__).resolve().parents[1]
    fixture_image = 'gameshelf:smb-write-test-server'
    subprocess.run(['docker', 'build', '--tag', fixture_image, str(repo / 'tests/smb-write-fixture')], check=True)
    network = 'gameshelf-smb-write-' + uuid.uuid4().hex[:12]
    server = app = None
    docker('network', 'create', '--internal', network)
    try:
        # tmpfs, not a user bind mount; nothing persists after the container exits.
        server = docker('run', '--detach', '--network', network, '--network-alias', 'smb-write-fixture',
                        '--security-opt', 'no-new-privileges:true',
                        '--tmpfs', '/fixture:rw,noatime,nosuid,nodev,size=16m', fixture_image)
        docker('exec', server, 'python3', '/fixture.py', 'seed')

        def smb(commands):
            return docker('exec', server, 'smbclient', '//127.0.0.1/games',
                          '-U', 'writer%fixture-write-password', '-c', commands)

        # Independently establish that the exact account GameShelf will use can
        # create, overwrite, rename, read back and delete through SMB (not root FS).
        for attempt in range(60):
            try:
                smb('ls')
                break
            except subprocess.CalledProcessError:
                if attempt == 59:
                    raise
                time.sleep(.2)
        smb('put /probe-first .permission-probe')
        assert docker('exec', server, 'cat', '/fixture/.permission-probe') == 'first probe'
        smb('put /probe-second .permission-probe')
        assert docker('exec', server, 'cat', '/fixture/.permission-probe') == 'overwritten probe'
        smb('rename .permission-probe .renamed-probe')
        docker('exec', server, 'test', '!', '-e', '/fixture/.permission-probe')
        assert docker('exec', server, 'cat', '/fixture/.renamed-probe') == 'overwritten probe'
        smb('get .renamed-probe /probe-readback')
        assert docker('exec', server, 'cat', '/probe-readback') == 'overwritten probe'
        smb('del .renamed-probe; mkdir .directory-probe')
        docker('exec', server, 'test', '!', '-e', '/fixture/.renamed-probe')
        docker('exec', server, 'test', '-d', '/fixture/.directory-probe')
        smb('rmdir .directory-probe')
        docker('exec', server, 'test', '!', '-e', '/fixture/.directory-probe')
        print('PASS: exact SMB credentials independently proved create/overwrite/read/rename/delete/mkdir/rmdir', flush=True)

        def snapshot():
            return json.loads(docker('exec', server, 'python3', '/fixture.py', 'snapshot'))

        baseline = snapshot()

        def unchanged(label):
            actual = snapshot()
            changed = sorted(key for key in baseline.keys() | actual.keys() if baseline.get(key) != actual.get(key))
            assert not changed, f'{label} modified remote fixture: {changed}'
            print('PASS: unchanged remote names/content/metadata after ' + label, flush=True)

        app = docker('run', '--detach', '--network', network, '--read-only', '--cap-drop=ALL',
                     '--security-opt', 'no-new-privileges:true', '--publish', '127.0.0.1::8080', image)
        base = 'http://' + docker('port', app, '8080/tcp').splitlines()[0]

        def request(path, value=None, method=None, raw=False, headers=None):
            req = urllib.request.Request(base + path, data=json.dumps(value).encode() if value is not None else None,
                                         method=method, headers={'Content-Type': 'application/json', **(headers or {})})
            with network_smoke.open_respecting_refresh_limit(req, timeout=120) as response:
                content = response.read()
                return content if raw else json.loads(content)

        for attempt in range(60):
            try:
                setup = request('/api/setup')
                break
            except (OSError, urllib.error.URLError):
                if attempt == 59:
                    raise
                time.sleep(.2)
        assert setup['required'] and setup['mounts'] == [], setup
        assert docker('exec', app, 'id', '-u') == '10001'
        source = dict(id='', name='Writable SMB security fixture', protocol='smb',
                      url='smb://smb-write-fixture/games', username='writer', password='fixture-write-password')
        result = request('/api/network-test', source)
        source.update(result['source'])
        source['password'] = 'fixture-write-password'
        unchanged('connection test')
        request('/api/setup', dict(setup['settings'], rootDir='', rootDirs=[], sources=[source], refreshInterval='0'), 'POST')
        games = request('/api/games')
        assert {game['name'] for game in games} == {'Writable Game', 'Second Game'}, games
        unchanged('setup and indexing')
        assert len(request('/api/games?forceRefresh=1')) == 2
        unchanged('forced scan')
        for game in games:
            ident = urllib.parse.quote(game['id'], safe='')
            expected = {
                'game.bin': (game['name'] + ' payload\n').encode(),
                'cover.png': base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM2kAAAAASUVORK5CYII='),
                'nested/notes.txt': b'nested fixture\n', '.sentinel': b'hidden sentinel\n',
            }
            listing = request('/api/game-files/' + ident)
            assert {item['path'] for item in listing['files']} == set(expected), listing
            unchanged('file listing ' + ident)
            assert request('/covers/' + ident, raw=True) == expected['cover.png']
            unchanged('artwork ' + ident)
            assert request('/api/game-file/' + ident + '?path=game.bin', raw=True) == expected['game.bin']
            assert request('/api/game-file/' + ident + '?path=nested%2Fnotes.txt', raw=True,
                           headers={'Range': 'bytes=1-4'}) == expected['nested/notes.txt'][1:5]
            unchanged('individual and range downloads ' + ident)
            archive = zipfile.ZipFile(io.BytesIO(request('/download/' + ident, raw=True)))
            assert {item.filename: archive.read(item) for item in archive.infolist()} == expected
            unchanged('ZIP ' + ident)
            game['expected'] = expected

        query = urllib.parse.urlencode([('game', game['id']) for game in games])
        for route in ['/download-playlist', '/download-cart']:
            archive = zipfile.ZipFile(io.BytesIO(request(route + '?' + query, raw=True)))
            expected = {game['id'] + '/' + name: content for game in games for name, content in game['expected'].items()}
            assert {item.filename: archive.read(item) for item in archive.infolist()} == expected
            unchanged(route)

        # Real UI add/remove/clear/download with a fresh browser profile and no API mocks.
        subprocess.run(['node', str(repo / 'tests/smb-playlist-live.cjs'), base], check=True, timeout=60)
        unchanged('browser Playlist add/remove/clear/download')

        for method in ['PUT', 'POST', 'PATCH', 'DELETE', 'MOVE', 'COPY']:
            for route in ['/api/game-files/' + ident, '/api/game-file/' + ident + '?path=game.bin',
                          '/covers/' + ident, '/download/' + ident, '/download-playlist?' + query, '/download-cart?' + query]:
                try:
                    request(route, {'operation': 'delete', 'destination': 'renamed.bin'}, method, raw=True)
                    raise AssertionError(f'accepted {method} {route}')
                except urllib.error.HTTPError as error:
                    assert error.code == 405, (method, route, error.code)
        for operation in ['write', 'delete', 'rename', 'copy', 'move', 'purge', 'mkdir']:
            try:
                request('/api/network-test', dict(source, operation=operation))
                raise AssertionError('accepted injected operation ' + operation)
            except urllib.error.HTTPError as error:
                assert error.code == 400, (operation, error.code)
        unchanged('unsupported HTTP methods and injected write/delete/rename operations')
        docker('stop', app)
        unchanged('application shutdown')
    finally:
        for cid in [app, server]:
            if cid:
                try:
                    print(docker('logs', cid))
                finally:
                    docker('rm', '--force', '--volumes', cid)
        docker('network', 'rm', network)


if __name__ == '__main__':
    main(sys.argv[1])
