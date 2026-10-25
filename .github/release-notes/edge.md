## Added

- Library Manager groups Sources, Library Health, and Refresh Interval; health monitoring and saved health logs open their own submenus.
- Guardian controls for Settings-menu and Advanced-tab PIN access, Basic/Advanced placement, grouped categories, and disabled-control hints.
- Joined app-themed dropdown lists with keyboard/type-ahead support, plus smooth expansion and contraction for dynamically resized menus and setup panels.

## Changes

- GameShelf Classic is the new-install default. System now chooses Light or Dark; theme choices use a fixed first group followed by alphabetical themes.
- Refined setup help, stable background-case visibility, compact PIN errors as banners, library-location ellipses, and consistent Playlist/icon/log-button feedback.
- Library health has a default-on Application Logs category alongside its persistent exportable history.

## Security

- PIN changes revoke every current browser unlock, including the changing browser. Verification and rotation are serialized to prevent stale-PIN grants.
- Settings, Advanced, and Library Manager permissions are enforced on relevant server operations as well as menu entry. Gate controls remain recoverable.
- Manual refresh uses a ten-second server-wide cooldown and prevents concurrent manual discovery from queueing; repeated requests receive Retry-After.

## Other

- Documented Library Manager and Guardian behavior; added optional local nickname/PIN sessions and per-library/per-game family access to the roadmap.
