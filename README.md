# rconsole

A lightweight web console for managing a Minecraft server over RCON. No dependencies, Node.js 18+.

- **Console**: live server log (chat, joins, warnings, errors) with filter and chat-only view, plus a command prompt with history (↑/↓)
- **Stats**: TPS/MSPT, players, in-game day and time, host CPU, RAM, disk and uptime
- **Players**: whitelist (with on/off switch), operators, banned players and IPs, with one-click add and remove
- **Backups**: one-click world backups (autosave paused during the copy), download, delete, automatic retention
- **Schedule**: daily or weekly restarts with in-game countdown warnings, backups and arbitrary commands
- **Security**: user accounts with scrypt-hashed passwords, optional TOTP 2FA, session cookies, brute-force lockout, audit log, strict CSP, sandboxed systemd service

## Security model

- **Accounts** live in `/var/lib/rconsole/users.json` with scrypt password hashes. They're managed with `cli.js` on the server only; there is no web signup.
- **Sessions** are random 256-bit tokens in an `HttpOnly`, `SameSite=Strict` cookie, `Secure` when served over HTTPS. They expire after 12 h idle or 7 days, and are revoked when the password changes or the user is removed. Sessions are kept in memory, so restarting rconsole signs everyone out.
- **2FA**: optional TOTP per user, with replay protection.
- **Brute force**: 5 failed logins per client IP or per username within 15 minutes lock that IP or name for 15 minutes.
- **Cross-site requests**: state-changing requests must be same-origin and JSON.
- **Audit**: every command, backup, restart and login is logged with the user name (`journalctl -u rconsole`).
- **Process**: runs as its own `rconsole` user with read-only access to the Minecraft directory, write access only to its state and backup directories, and only the capability to bind port 80.

rconsole speaks plain HTTP. Put it behind a TLS reverse proxy (see Traefik below) and set `TRUST_PROXY` to the proxy's IP, so client IPs and `Secure` cookies are correct. For defence in depth, firewall port 80 so only the proxy can reach it.

## Setup on Debian

Assumes Minecraft runs as user and group `minecraft` from `/srv/minecraft`.

### 1. Enable RCON

In `/srv/minecraft/server.properties`, then restart Minecraft:

```properties
enable-rcon=true
rcon.port=25575
rcon.password=change-me
```

Never expose port 25575. RCON is unencrypted.

### 2. Let Minecraft restart itself

rconsole restarts the server by sending `stop`. systemd has to bring it back:

```sh
sudo systemctl edit minecraft
```

```ini
[Service]
Restart=always
RestartSec=10
```

`systemctl stop minecraft` still stops it for good. Only exits systemd didn't ask for are restarted.

### 3. Install

```sh
sudo apt install -y nodejs git
sudo useradd --system --no-create-home --shell /usr/sbin/nologin rconsole
sudo mkdir -p /opt/rconsole && sudo chown $USER: /opt/rconsole
gh repo clone iamozyth/rconsole /opt/rconsole
```

### 4. Give rconsole read access to Minecraft

rconsole joins the `minecraft` group (via `SupplementaryGroups=` in the unit). The group needs read access:

```sh
sudo chmod -R g+rX /srv/minecraft
```

New files Minecraft creates stay group-readable as long as its unit doesn't set a strict umask. Check with `systemctl show minecraft -p UMask`: `0022` or `0027` are fine, `0077` is not.

Backups go to their own directory:

```sh
sudo mkdir -p /srv/minecraft-backups
sudo chown rconsole:rconsole /srv/minecraft-backups
sudo chmod 750 /srv/minecraft-backups
```

### 5. Configure and start

```sh
sudo cp /opt/rconsole/rconsole.env.example /etc/rconsole.env
sudo chmod 600 /etc/rconsole.env
sudoedit /etc/rconsole.env
sudo cp /opt/rconsole/rconsole.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now rconsole
```

### 6. Create your account

```sh
cd /opt/rconsole
sudo -u rconsole node cli.js user add yourname
sudo -u rconsole node cli.js user totp yourname   # optional 2FA, highly recommended
```

Other commands: `user list`, `user passwd <name>`, `user remove <name>`, `user totp-off <name>`. Changes apply immediately, no restart needed.

## Configuration

`/etc/rconsole.env`:

| Variable        | Default                  | Description                                          |
|-----------------|--------------------------|------------------------------------------------------|
| `RCON_PASSWORD` | (required)               | Matches `rcon.password`                              |
| `RCON_HOST`     | `127.0.0.1`              | Minecraft server host                                |
| `RCON_PORT`     | `25575`                  | RCON port                                            |
| `WEB_HOST`      | `127.0.0.1`              | Address to bind (`0.0.0.0` for a proxy on another host) |
| `WEB_PORT`      | `8080`                   | Port to listen on                                    |
| `TRUST_PROXY`   | (none)                   | Comma-separated proxy IPs allowed to set `X-Forwarded-*` |
| `MC_DIR`        | `/srv/minecraft`         | Server directory (logs, lists, worlds)               |
| `BACKUP_DIR`    | `/srv/minecraft-backups` | Where backups are written (outside `MC_DIR`)         |
| `BACKUP_KEEP`   | `10`                     | Newest backups to keep, `0` keeps all                |

## Traefik

File provider example, with Traefik on another host:

```yaml
http:
  routers:
    rconsole:
      rule: Host(`rcon.example.com`)
      entryPoints: [websecure]
      service: rconsole
      tls:
        certResolver: letsencrypt
  services:
    rconsole:
      loadBalancer:
        servers:
          - url: http://10.10.7.2:80
        healthCheck:
          path: /healthz
          interval: 30s
```

Set `TRUST_PROXY` to the IP Traefik connects from.

## Updating

```sh
cd /opt/rconsole && git pull && sudo systemctl restart rconsole
```

If `rconsole.service` changed, copy it again and run `sudo systemctl daemon-reload` first.

## Notes

- TPS uses `tps` on Paper/Spigot and `tick query` on vanilla 1.20.3+. Older vanilla versions show `n/a`.
- Backups archive the world folders (`level-name`, plus `_nether` and `_the_end` if present) as `.tar.gz`.
- Player avatars load from mc-heads.net.
