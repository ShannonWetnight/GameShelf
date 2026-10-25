## Added

- Family Controls: four-digit PIN, individual Allow / Require PIN / Disable and visibility choices, and granular protection for settings, covers, favorites, destructive actions, Playlist, and downloads.
- Library Health: source status, last successful checks, bounded manual/scheduled probes, configurable monitoring, and exportable/restoreable history.
- A tenth original GameShelf Edition cover and more evenly scattered welcome artwork, with new sharing-focused setup wording.

## Fixed

- Duplicate/native tooltips, inconsistent button feedback and fonts, Cartridge Gray return styling, and card/banner corner clipping across themes.
- Cover controls now live in the editor with counterclockwise rotation, mirroring, and a disabled-stretch slash; card rain splashes remain visible above the title tray.
- Shuffle handoff no longer pauses and replays a second card animation; rear cases fade before the result appears.
- Skipped setup recovery remains visible in Basic settings after Wipe, and folder Select/Cancel actions share a width.
- Log downloads append their export event last without expanding the open log view; health-only backups and larger bounded log snapshots restore correctly.

## Security

- Server checks protect API operations independently of browser controls, including reset/restore paths and protected preference removal.
- Salted PIN hashing, limited attempts, short-lived scoped HttpOnly browser unlocks, and credential-free audit events.
- Private PIN rules survive Wipe/restore; backups include policies without PIN secrets, and fresh imports require a new PIN to unlock protected actions.

## Other

- Documented family-control behavior, recovery, monitoring, backup coverage, and security boundaries; added planned library filtering with health indicators to the roadmap.
