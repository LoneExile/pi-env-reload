# Changelog

## [Unreleased]

## [0.2.0] - 2026-09-06

### Added

- Opt-in auto reload: set `PI_ENV_RELOAD_AUTO` (e.g. `5m`, `30s`, or a bare
  number of seconds; `off` to disable) in the dotenv file and changed
  credentials are picked up on a timer without running `/env-reload`. Unset
  keeps the previous explicit-only behavior.
- Ticks check the file's mtime and size, so an unchanged file costs one stat;
  ticks during an active request are skipped and picked up later.
- OMP sessions use the harness-managed interval (cleared on session shutdown);
  Pi falls back to a raw unref'd interval cleared on `session_shutdown`.
  `PI_ENV_RELOAD_AUTO` values below a 30-second floor are clamped.

## [0.1.1] - 2026-08-26

### Added

- Pi support: uses Pi's `ModelRegistry.refresh({ force: true })` when
  `reapplyModelPolicies` is unavailable, and honors `PI_ENV_RELOAD_CONFIG_DIR`
  for the Pi `~/.pi/agent` config layout.
- Notifications now name the actual dotenv path being reloaded.

### Changed

- README documents the Pi `PI_ENV_RELOAD_CONFIG_DIR` requirement and the
  harness-specific dotenv locations.

## [0.1.0] - 2026-08-26

### Added

- `/env-reload` command that reloads `~/.omp/.env` into a running OMP or Pi session without a restart.
- The command waits for the active request to finish before reloading.
- Reloaded values are applied to the running process and the model registry is rebuilt, so static `models.yml` credentials (including `REFRESHER_*` provider keys) resolve to the new values.
- The command reports only a generic success or error message and never prints credential values.
