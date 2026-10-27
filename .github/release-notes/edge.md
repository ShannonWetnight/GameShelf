## Added

- Two Guardian PINs with unique profile links, an optional Guardian profile, and approvals bound to the signed-in Guardian.
- Three built-in roles, additive grants with administrative warnings, personal profile editing, hidden profiles, required PIN changes, and Profile audit activity.
- Fifty regular portraits, including twenty-five playful additions, plus an exclusive Guardian knight; matching cover/photo zoom and tilt tools.
- Optional backup passphrases with explicit unencrypted-export consent, complete Game Over backup access, and one approval across both Wipe confirmations.
- Staged setup libraries, persistent completion state, highlighted unfinished setup, compact source/health/PIN dialogs, aligned checkboxes, and cleaner category borders.

- Optional family nickname/PIN profiles during setup and in Family Controls, with personal favorites and preferences, starter/custom roles, and per-profile library/game assignments.
- Protected profile backups include roles, memberships, assignments, preferences, favorites, and salted PIN verifiers under a separate backup passphrase.
- Dynamic resolution scaling defaults to 100% for 1080p, 125% for 1440p, 150% for 4K, and 100% when detection is unavailable.

## Changes

- Settings descriptions move into themed hover hints with compact, aligned rows.
- UI Scale commits on release with a soft transition; manual control is available when dynamic scaling is disabled.
- PIN creation and remembrance settings have their own submenu; the unlock prompt is reduced to PIN Required.
- Cover editing has a narrower dialog, centered truncated title, and sliders bounded to the preview.
- Health icons align with text, and their meanings appear in three short rows. Saved passwords use generic placeholder dots.
- Dropdown highlights fill their last row and closing parent corners remain rounded.

## Fixed

- Opening protected Settings in its saved Advanced view no longer causes repeated PIN prompts. Open menus retain approval for their saves while separate action restrictions remain enforced.
- Restore file-picker feedback applies only to Choose File, without an extra tooltip.
- Family Controls center columns and dropdown text, order Library Manager first in its section, and report missing-PIN policy errors in notification banners.

## Security

- Profile restrictions are enforced on catalogs, statistics, cover/file routes, and single/bulk ZIP downloads.
- Profile/role changes revoke sessions; switching profiles clears Guardian unlocks. Login is rate limited, and private records fail closed when unreadable.
- AES-256-GCM profile exports use a separately derived passphrase key. Restore validates the authenticated document before replacement and never imports Guardian PIN authority.
