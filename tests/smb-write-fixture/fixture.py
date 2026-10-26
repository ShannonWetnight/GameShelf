"""Independent server-side inventory, not the client's SMB listing/cache."""
import base64
import hashlib
import json
import os
import pathlib
import stat
import sys

ROOT = pathlib.Path('/fixture')
COVER = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM2kAAAAASUVORK5CYII=')


def snapshot(root=ROOT):
    result = {}
    for path in [root, *sorted(root.rglob('*'))]:
        info = path.lstat()
        entry = dict(mode=info.st_mode, uid=info.st_uid, gid=info.st_gid,
                     links=info.st_nlink, size=info.st_size,
                     mtime_ns=info.st_mtime_ns, ctime_ns=info.st_ctime_ns,
                     xattrs={name: os.getxattr(path, name).hex()
                             for name in sorted(os.listxattr(path))})
        # atime is deliberately excluded: reads may update it. All content,
        # ownership, permissions, modification/change times and xattrs must match.
        if stat.S_ISREG(info.st_mode):
            entry['sha256'] = hashlib.sha256(path.read_bytes()).hexdigest()
        elif stat.S_ISLNK(info.st_mode):
            entry['target'] = os.readlink(path)
        result[str(path.relative_to(root))] = entry
    return result


if __name__ == '__main__':
    if sys.argv[1] == 'seed':
        for name in ['Writable Game', 'Second Game']:
            game = ROOT / name
            (game / 'nested').mkdir(parents=True)
            (game / 'empty').mkdir()
            (game / 'game.bin').write_bytes((name + ' payload\n').encode())
            (game / 'cover.png').write_bytes(COVER)
            (game / 'nested' / 'notes.txt').write_bytes(b'nested fixture\n')
            (game / '.sentinel').write_bytes(b'hidden sentinel\n')
        for path in [ROOT, *ROOT.rglob('*')]:
            os.chown(path, 10001, 10001)
            path.chmod(0o755 if path.is_dir() else 0o644)
        pathlib.Path('/probe-first').write_bytes(b'first probe')
        pathlib.Path('/probe-second').write_bytes(b'overwritten probe')
    elif sys.argv[1] == 'snapshot':
        print(json.dumps(snapshot(), sort_keys=True))
    else:
        raise SystemExit('unknown fixture action')
