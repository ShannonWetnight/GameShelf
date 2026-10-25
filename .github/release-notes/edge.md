## Added

- Saved UI scaling from 75% to 150%, with a new default of 125%.
- Optional PIN remembrance with a Guardian-configured duration of 1–60 minutes (default five); one-request approval when remembrance is unchecked or disabled.
- Network reachability indicators beside library nicknames, a separate manual-refresh tour step, and an edge-snapping toggle in the cover editor.

## Changes

- Compact network setup/edit forms use success and error banners instead of inline test messages.
- Dropdowns animate open and closed, retain their themed caret and joined edges, and stay anchored during scaling and scrolling.
- Family Controls use equal dropdown widths, individually rounded categories, column/control hints, and Library Manager as the final category.
- Cover tools are centered with rotate last, matched sliders with live value hints, and a vertically centered Cancel action.
- New servers enable all logging sources by default; existing saved logging choices remain intact.
- Setup requires a location before continuing, preserves smoother expansion/collapse, and transitions into the tour without exposing an intermediate bright background.

## Fixed

- Refresh cooldown uses warning feedback and a soft red text glow without starting another client request.
- Search focus has a thicker accent outline; all themes use a stronger header divider.
- UI scale and PIN remembrance settings persist through supported backup/restore paths; private PIN secrets remain excluded from current backups.

## Security

- One-use PIN approvals are scoped, short-lived, session-bound, consumed atomically for a whole request, and cannot be replayed across concurrent requests.
- Remembrance duration is enforced on the server. PIN/policy changes revoke existing grants and one-use approvals.

## Other

- Expanded the roadmap for optional family-profile setup, starter/custom roles, portable protected profile data, and an isolated anonymous public demo.
