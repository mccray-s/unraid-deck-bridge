###2026.10.30a
- Fix: Complete plugin removal when API introspection is disabled.

###2026.10.30
- Fix: Allow newer Unraid OS and API releases above the minimum supported versions.
- Fix: Keep management capabilities available on newer hosts.

###2026.10.29a
- Change: Use one date-based release identity across the native plugin, Bridge, Core, diagnostics, and release artifacts.
- Fix: Activate upgrades from legacy Bridge 0.1.1 through the normal native plugin update without removing settings or task journals.
- Fix: Restart the previous runtime safely after a failed same-day revision upgrade.
- Fix: Preserve full native changelog history and reject inconsistent or overwritten release artifacts.

###2026.10.29
- Fix: Wait for stable API startup before activating Bridge.
- Change: Reload the API only when extension registration or the loaded adapter requires it.
- Add: Retain bounded lifecycle diagnostics across reboots.

###2026.10.28
- Initial Release: Native Unraid Deck Bridge plugin with the GraphQL adapter and Core runtime.
