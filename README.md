# pi-env-reload

[![npm version](https://img.shields.io/npm/v/pi-env-reload.svg)](https://www.npmjs.com/package/pi-env-reload)
[![npm downloads](https://img.shields.io/npm/dm/pi-env-reload.svg)](https://www.npmjs.com/package/pi-env-reload)
[![CI](https://github.com/LoneExile/pi-env-reload/actions/workflows/ci.yml/badge.svg)](https://github.com/LoneExile/pi-env-reload/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/pi-env-reload.svg)](./LICENSE)

Reload API credentials from a dotenv file in a running [Oh My Pi](https://omp.dev) or [Pi](https://pi.dev) session, without a restart.

## Install

### Oh My Pi

```bash
omp plugin install npm:pi-env-reload
```

### Pi

```bash
pi install npm:pi-env-reload
```

Start a new session after installing the package. Extensions are discovered when the session starts.

## Use

Edit the dotenv file for your harness, then run this command in the active session:

```text
/env-reload
```

The command waits for any active request to finish, reloads the file into the running process, and rebuilds the model registry. This supports credentials referenced by static `models.yml` entries, including custom providers whose `apiKey` points at a variable such as `REFRESHER_ANTHROPIC_KEY`.

The command reports only a generic success or error message. It never prints credential values.

### Which dotenv file?

- **Oh My Pi**: `~/.omp/.env` (or the active profile's `.env`).
- **Pi**: set `PI_ENV_RELOAD_CONFIG_DIR` to the Pi config directory holding the
  dotenv file, e.g. `~/.pi/agent`:

  ```bash
  PI_ENV_RELOAD_CONFIG_DIR=$HOME/.pi/agent pi
  ```

  Without the override the extension reads the `~/.omp` default, so Pi users
  must set it once (export it in your shell profile).

## Scope and limitations

- The extension reloads the dotenv file at the configured config root:
  `~/.omp/.env` on OMP (or the active profile's `.env`), and the
  `PI_ENV_RELOAD_CONFIG_DIR` path on Pi.
- Pi support requires `PI_ENV_RELOAD_CONFIG_DIR`; without it Pi reads the
  `~/.omp` default, which does not match Pi's `~/.pi/agent` layout.
- It updates the current process only. Child shells and future OMP processes use their own environment.
- Values supplied by a `!command` entry in `models.yml` remain subject to OMP's command-result cache.
- The reload is explicit. The package does not watch the file or reload credentials during an active request.

## Develop

```bash
npm install
npm run typecheck
npm test
npm pack --dry-run
```
