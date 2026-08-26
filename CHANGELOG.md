# Changelog

## [Unreleased]

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
