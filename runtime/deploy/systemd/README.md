# Alice Runtime systemd deployment

This unit is the host-side hardening half of ADR-207.

## What it does

- moves mutable runtime state out of the repo tree with `ALICE_STATE_DIR`
- keeps the Engine API socket in `/run/alice-runtime/engine.sock`
- keeps the error log in `/var/log/alice-runtime/alice-errors.log`
- defaults the skill runner to `sandboxed` + `runsc`
- applies `systemd.exec` hardening around the Node runtime process

## Before enabling the service

1. Copy the repo to its final location and adjust the unit paths:
   - `WorkingDirectory=/srv/alice-telegram-bot/runtime`
   - `EnvironmentFile=-/srv/alice-telegram-bot/runtime/.env`
   - every `ReadWritePaths=/srv/alice-telegram-bot/...`
2. Ensure Docker and gVisor are installed.
3. Create the service account:

```bash
sudo useradd --system --home /var/lib/alice-runtime --shell /usr/sbin/nologin alice-runtime
sudo usermod -aG docker alice-runtime
```

That is the compatibility path. If you want the stricter host-side setup, point the unit at a dedicated rootless Docker socket instead of granting the service user `docker` group access.

4. Install runtime dependencies in `runtime/`:

```bash
cd /srv/alice-telegram-bot/runtime
pnpm install --frozen-lockfile
pnpm docker:build-runner
```

## Install

```bash
sudo cp runtime/deploy/systemd/alice-runtime.service /etc/systemd/system/alice-runtime.service
sudo systemctl daemon-reload
sudo systemctl enable --now alice-runtime
```

## Verify

```bash
systemctl status alice-runtime
journalctl -u alice-runtime -n 100 --no-pager
ls -la /run/alice-runtime/engine.sock
ls -la /var/lib/alice-runtime
ls -la /var/log/alice-runtime/alice-errors.log
```

## Writable paths

The unit deliberately keeps only these locations writable:

- `/var/lib/alice-runtime` - SQLite state, caches, `ALICE_HOME`
- `/run/alice-runtime` - Engine API Unix socket
- `/var/log/alice-runtime` - error log
- `runtime/skills/store` - installed skill payloads
- `runtime/skills/system-bin` - exported skill command symlinks
- `runtime/skills/man` - exported manpage symlinks
- `runtime/skills/registry.json` - installed skill registry

If you later move skill exports out of the repo tree, tighten `ReadWritePaths` again.
