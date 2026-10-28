# Pinned upstream materials

## @unraid/shared 4.25.3

- Obtained from an Unraid API `4.36.1+f3205d97` host at `/usr/local/unraid-api/packages/unraid-shared-4.25.3.tgz`.
- Upstream source: https://github.com/unraid/api/tree/v4.36.1/packages/unraid-shared
- License: GPL-2.0-or-later.

The archive is a pinned development dependency. It is not redistributed in the plugin runtime archive; the running plugin uses the official host package.

## AuthorizationGuard from Unraid API 4.37.4

`unraid-authorization-4.37.4.ts` preserves the upstream `AuthorizationGuard` source:

- Source: https://github.com/unraid/api/blob/v4.37.4/api/src/unraid-api/auth/authorization.guard.ts
- Audited commit: `ad268301ca78da1fa47fd3bb87e60fcedc458c5b`.
- SHA256: `db7bb221f9a19f51d23c6c3cb4697eb9f2943ad7b229bdb1aaf5f08e7ee62154`, pinned in the compatibility manifest.
- License: GPL-2.0-or-later.

This file is used only for local GraphQL authorization regression tests and is excluded from the plugin runtime archive. Test compilation substitutes two external application metadata constants and the request accessor; it does not replace or modify the guard's authorization decisions.
