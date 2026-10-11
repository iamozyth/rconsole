# rconsole

A lightweight web console for managing a Minecraft server over RCON. No dependencies, Node.js 18+.

- **Console**: live server log (chat, joins, warnings, errors) with filter and chat-only view, plus a command prompt with history (↑/↓)
- **Stats**: TPS/MSPT, players, in-game day and time, host CPU, RAM, disk and uptime
- **Players**: whitelist (with on/off switch), operators, banned players and IPs, with one-click add and remove
- **Backups**: one-click world backups (autosave paused during the copy), download, delete, automatic retention
- **Schedule**: daily or weekly restarts with in-game countdown warnings, backups and arbitrary commands
- HTTP Basic auth, strict Content-Security-Policy, binds to localhost by default

## 1. Enable RCON on the Minecraft server

In `server.properties`, then restart the server:

```properties
enable-rcon=true
rcon.port=25575
rcon.password=change-me
```

Never expose port 25575 to the internet. RCON is unencrypted.

## 2. Install

```sh
sudo mkdir -p /opt/rconsole && sudo chown $USER: /opt/rconsole
gh repo clone iamozyth/rconsole /opt/rconsole
```

## 3. Configure

| Variable        | Default                  | Description                                     |
|-----------------|--------------------------|-------------------------------------------------|
| `RCON_PASSWORD` | (required)               | Matches `rcon.password`                         |
| `WEB_PASSWORD`  | (required)               | Password for the web UI                         |
| `WEB_USER`      | `admin`                  | Username for the web UI                         |
| `WEB_HOST`      | `127.0.0.1`              | Address the web UI binds to (`0.0.0.0` for LAN) |
| `WEB_PORT`      | `8080`                   | Port the web UI listens on                      |
| `RCON_HOST`     | `127.0.0.1`              | Minecraft server host                           |
| `RCON_PORT`     | `25575`                  | RCON port                                       |
| `MC_DIR`        | `/srv/minecraft`         | Server directory (logs, lists, worlds)          |
| `BACKUP_DIR`    | `/srv/minecraft-backups` | Where backups are written (outside `MC_DIR`)    |
| `BACKUP_KEEP`   | `10`                     | Newest backups to keep, `0` keeps all           |
| `STATE_DIR`     | `./data`                 | Where scheduled tasks are saved (systemd sets this via `StateDirectory`) |

### Permissions

The user running rconsole needs:

- **read** access to `MC_DIR`: `logs/latest.log`, `server.properties`, the `*.json` lists and the world folders (for backups)
- **write** access to `BACKUP_DIR`

If Minecraft runs as a different user, add rconsole's user to that user's group, for example `sudo usermod -aG minecraft debian`, and make sure files are group-readable.

### Restarts

A restart sends `save-all flush` and then `stop`. Something has to start Minecraft again, for example a systemd unit with `Restart=always`. Without that, a "restart" is a shutdown.

## 4. Run as a service

```sh
sudo mkdir -p /srv/minecraft-backups && sudo chown debian: /srv/minecraft-backups
sudo cp /opt/rconsole/rconsole.env.example /etc/rconsole.env
sudo chmod 600 /etc/rconsole.env
sudoedit /etc/rconsole.env
sudo cp /opt/rconsole/rconsole.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now rconsole
journalctl -u rconsole -f
```

Adjust `User=` and `ReadWritePaths=` in the unit if your user or backup directory differ. The backup directory must exist before the service starts.

### Updating

```sh
cd /opt/rconsole && git pull && sudo systemctl restart rconsole
```

If `rconsole.service` changed, copy it again and run `sudo systemctl daemon-reload` first.

## Remote access

Basic auth over plain HTTP sends your password in the clear. Keep the UI on localhost or a trusted LAN. From elsewhere, use an SSH tunnel:

```sh
ssh -L 8080:127.0.0.1:8080 you@your-server
```

or a TLS reverse proxy such as Caddy:

```
rcon.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

## Notes

- TPS uses `tps` on Paper/Spigot and `tick query` on vanilla 1.20.3+. Older vanilla versions show `n/a`.
- Backups archive the world folders (`level-name`, plus `_nether` and `_the_end` if present) as `.tar.gz`.
- Player avatars load from mc-heads.net.
