# rconsole

> [!WARNING]
> **Early preview, vibe-coded.** rconsole was written almost entirely by an AI coding assistant (Claude Code) in a few sessions, with a human steering, reviewing and testing it on one homelab server. It has automated tests and was checked against a real Paper server, but it has not had an independent security review or wide real-world use. Expect rough edges and breaking changes. Run it on a trusted network, keep your own backups, and read the code before you give it control of a server you care about.

A lightweight web console for managing a Minecraft server over RCON. No dependencies, Node.js 18+.

- **Console**: live server log (chat, joins, warnings, errors) with filter and chat-only view, plus a command prompt with history (↑/↓) and autocomplete: commands with descriptions and syntax, subcommands, online/whitelisted/banned players, game modes, game rules (Tab to complete, Ctrl+Space to list). Plugin commands are discovered from the server's `help`.
- **Command palette**: Ctrl+K (⌘K) to jump to any view, run actions (restart, backup, maintenance, update checks…) or pick a Minecraft command
- **Stats**: TPS/MSPT, players, in-game day and time, host CPU, RAM, disk and uptime
- **Players**: whitelist (with on/off switch), operators, banned players and IPs, with one-click add and remove; history of everyone who played (sessions, playtime, last IP, daily activity) built from the server logs
- **Server**: start, stop and restart the Minecraft service with in-game countdowns; maintenance mode (only operators can join, whitelist restored afterwards)
- **Worlds**: switch between worlds, create new ones (seed, type), delete with an automatic archive
- **Backups**: per-world backups (autosave paused during the copy), download, delete, per-world retention, and restore, either over a world (with a safety backup, stopping the server if needed) or as a new world
- **Insights**: 24 h and 7 day charts of TPS, players, CPU and memory (host and Minecraft process) with downtime marked; search across `latest.log` and all rotated `.log.gz` files; a filterable audit trail of every change and sign-in
- **Notifications**: push alerts through [ntfy](https://ntfy.sh): server down/up, lag, failed backups and tasks, low disk, new updates, sign-in lockouts, optionally joins
- **Map**: squaremap (or BlueMap) inside rconsole, behind your sign-in and isolated from it
- **Prometheus**: `/metrics` with a bearer token
- **Schedule**: daily or weekly restarts with in-game countdown warnings, backups and arbitrary commands
- **Settings**: edit `server.properties` through a typed form with a review step; difficulty, game mode and whitelist apply live, everything else is flagged "restart to apply"
- **Plugins**: identify installed jars on Modrinth by hash, update (with rollback), enable/disable, remove, and search and install new plugins for your Minecraft version, SHA-512 verified
- **Updates**: Paper/Folia build and Minecraft version updates from PaperMC, SHA-256 verified, with automatic backup, countdown restart and one-click rollback
- **Security**: user accounts with scrypt-hashed passwords, optional TOTP 2FA, session cookies, brute-force lockout, audit log, strict CSP, sandboxed systemd service

## Security model

- **Accounts** live in `/var/lib/rconsole/users.json` with scrypt password hashes. They're managed with `cli.js` on the server only; there is no web signup.
- **Sessions** are random 256-bit tokens in an `HttpOnly`, `SameSite=Strict` cookie, `Secure` when served over HTTPS. They expire after 12 h idle or 7 days, and are revoked when the password changes or the user is removed. Sessions are kept in memory, so restarting rconsole signs everyone out.
- **2FA**: optional TOTP per user, with replay protection.
- **Brute force**: 5 failed logins per client IP or per username within 15 minutes lock that IP or name for 15 minutes.
- **Cross-site requests**: state-changing requests must be same-origin and JSON.
- **Audit**: every state-changing request, sign-in (including failed ones), scheduled task and background operation is recorded with user, IP and outcome in `/var/lib/rconsole/audit.jsonl` (rotated at 5 MB, passwords and codes never stored) and shown under Insights → Audit. The same events also go to `journalctl -u rconsole`.
- **Process**: runs as its own `rconsole` user with read-only access to the Minecraft directory, write access only to its state and backup directories, and only the capability to bind port 80.
- **Privileged jobs**: anything that writes to the Minecraft directory (backups, restores, world changes, `server.properties`, jar updates) runs as the Minecraft user in sandboxed systemd units, `rconsole-job@` (no network) and `rconsole-net@` (downloads), executing the fixed script `bin/mc-helper.js`. rconsole only drops a request file; the helper validates it again (typed allowlist for `server.properties`, safe names, archives checked for links and stray paths) and keeps every path inside the server and backup directories. RCON and port settings can't be changed from rconsole.
- **polkit** lets the `rconsole` user start exactly these job units and start/stop/restart `minecraft.service`, nothing else. Signed-in users are full admins: RCON commands and plugin installs (from Modrinth) run with the Minecraft server's rights by design. rconsole itself can't make the helper write outside its fixed job types, and updates only install downloads whose hash matches the publisher's API.

rconsole speaks plain HTTP. Put it behind a TLS reverse proxy (see Traefik below) and set `TRUST_PROXY` to the proxy's IP, so client IPs and `Secure` cookies are correct. For defence in depth, firewall port 80 so only the proxy can reach it.

## Quick install

On a Debian or Ubuntu host where your Minecraft server already runs as a systemd service:

```sh
curl -fsSL https://raw.githubusercontent.com/iamozyth/rconsole/main/install.sh | sudo bash
```

The installer finds the server (its service, folder, user, jar and software: Paper, Purpur, Folia, Spigot, Fabric, Quilt, Forge, NeoForge or vanilla) and shows what it found before changing anything. Then it:

- installs Node.js, git and polkit if missing;
- clones rconsole to `/opt/rconsole` and creates the `rconsole` system user;
- turns on RCON with a generated password if needed (the old file is kept as `server.properties.before-rconsole`);
- makes the server folder group-readable, creates the backup folder, and adds `Restart=always` to the Minecraft service if it has no restart policy (rconsole restarts the server by stopping it);
- writes `/etc/rconsole.env`, installs the units and polkit rule for your paths, user and service name, and starts rconsole;
- creates your first account.

It never overwrites values already in `/etc/rconsole.env` and can be run again at any time. Options: `--mc-dir`, `--service`, `--backup-dir`, `--host`, `--port` (default `0.0.0.0:8080`), `--admin NAME`, `--yes` (no questions; a generated password is printed), `--dry-run` (show what would change) and `--uninstall`. Pass options through the pipe with `| sudo bash -s -- --dry-run`. Rather read it first: `curl -fsSLO …/install.sh && less install.sh && sudo bash install.sh`.

Afterwards put rconsole behind TLS (see Traefik) and set `TRUST_PROXY`. The manual steps below describe the same setup.

## Setup on Debian (manual)

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

Backups go to their own directory, written by the Minecraft user and readable (and deletable) by rconsole through the group:

```sh
sudo mkdir -p /srv/minecraft-backups
sudo chown minecraft:minecraft /srv/minecraft-backups
sudo chmod 2770 /srv/minecraft-backups
```

### 5. Allow helper jobs, server control and self-update

```sh
sudo apt install -y polkitd
sudo cp /opt/rconsole/rconsole-job@.service /opt/rconsole/rconsole-net@.service /opt/rconsole/rconsole-selfupdate.service /etc/systemd/system/
sudo cp /opt/rconsole/50-rconsole.rules /etc/polkit-1/rules.d/
sudo systemctl daemon-reload
```

The units assume `/opt/rconsole`, `/srv/minecraft`, `/srv/minecraft-backups` and the user `minecraft`. The polkit rule assumes the server runs as `minecraft.service`. Adjust them if yours differ, and set `MC_SERVICE` to match. `MC_JAR` (default `paper.jar`) must match the jar your Minecraft unit starts.

### 6. Configure and start

```sh
sudo cp /opt/rconsole/rconsole.env.example /etc/rconsole.env
sudo chmod 600 /etc/rconsole.env
sudoedit /etc/rconsole.env
sudo cp /opt/rconsole/rconsole.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now rconsole
```

### 7. Create your account

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
| `MC_JAR`        | `paper.jar`              | Server jar in `MC_DIR` that updates replace          |
| `MC_SERVICE`    | `minecraft.service`      | systemd unit rconsole starts, stops and restarts     |
| `NTFY_URL` / `NTFY_TOKEN` | (none) | ntfy topic and token; otherwise set them in the UI (Server → Overview) |
| `PUBLIC_URL`    | (none)                   | rconsole's own URL for notification links (otherwise set in the UI) |
| `METRICS_TOKEN` | (none)                   | Enables `/metrics` for Prometheus with this bearer token |
| `MAP_URL`       | (none)                   | squaremap/BlueMap web server, e.g. `http://127.0.0.1:8100` |
| `SELF_UPDATE_CHECK` | `1`                  | `0` turns off the background check for rconsole updates |
| `MODRINTH_API`  | `https://api.modrinth.com/v2` | Modrinth API for the plugin manager             |

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

rconsole checks GitHub every 6 hours for new commits on `main` (Server → Updates shows the changelog, the rail shows a notice) and can update itself with one click. The update runs in `rconsole-selfupdate.service` as root, a fixed script (`bin/self-update.sh`) that takes no input from rconsole:

1. fetches and fast-forwards `/opt/rconsole` (refuses if the checkout has local changes or has diverged),
2. checks the new code parses, otherwise stays on the old version,
3. installs changed unit files and the polkit rule, unless your installed copy was customized (then it tells you what to merge),
4. restarts rconsole, and rolls back if it doesn't come up.

One-time setup (rconsole must be a `git clone` in `/opt/rconsole`):

```sh
cd /opt/rconsole && sudo git pull
sudo cp rconsole-selfupdate.service /etc/systemd/system/
sudo cp 50-rconsole.rules /etc/polkit-1/rules.d/
sudo systemctl daemon-reload && sudo systemctl restart rconsole
```

From then on, use **Update rconsole** in the UI, or by hand:

```sh
sudo systemctl start rconsole-selfupdate.service   # same as the button
journalctl -u rconsole-selfupdate                  # what it did
```

Set `SELF_UPDATE_CHECK=0` in `/etc/rconsole.env` to turn off the background check.

## Updates

The **Updates** tab reads the running Paper version from the server log and lists newer builds for that Minecraft version, plus newer Minecraft versions. An update:

1. backs up the world (optional, on by default),
2. downloads the build from PaperMC and checks its SHA-256 against the API,
3. swaps the jar, keeping the old one as `paper.jar.previous`,
4. restarts the server with the usual in-game countdown.

**Roll back** swaps `paper.jar.previous` back in and restarts. That undoes a build update. A Minecraft version upgrade converts the world, so after one of those, only restoring the backup gets you back.

If a step fails, the UI shows the error. Details are in `journalctl -u 'rconsole-net@*'` or `journalctl -u 'rconsole-job@*'`.

## Insights

- **Metrics** are sampled every 30 seconds while rconsole runs: TPS/MSPT, players online, host CPU and memory, and the Minecraft process's CPU and RSS (from `/proc/<MainPID>`, so it needs `MC_SERVICE` to be readable via `systemctl show`). 24 hours are kept at full resolution and 7 days as 5-minute averages, in `/var/lib/rconsole/metrics.json`.
- **Player history** is rebuilt from `logs/latest.log` and `logs/*.log.gz`. What has been read from rotated logs is cached in `/var/lib/rconsole/players.json`, so history survives old logs being deleted. Log lines only carry a time of day; dates come from the rotated file names and the last write of `latest.log`.
- **Log search** reads newest first and stops at 500 matches or after 8 seconds; use the date range to reach further back.

## Connection attempts

**Players → Security** lists addresses that connected but never logged in and from which no player has ever logged in, read from all logs (`Name (/1.2.3.4:61000) lost connection`, whitelist refusals, nameless probes). These are mostly scanners that search the internet for open servers; the number after the colon is the scanner's own source port, not a port on your side. The page checks whitelist and online mode, suggests what to change, and offers **Ban IP** and a ready-made `ufw` rule. A dot on Players and an optional ntfy alert flag new attempts.

## Server software

rconsole detects what runs in `MC_DIR` from the startup lines of `logs/latest.log` (falling back to files only that software creates) and shows it in the sidebar. Everything that talks RCON or reads `server.properties` works the same everywhere; the rest adapts:

| Software | Add-ons (Server → …) | Automatic updates |
|---|---|---|
| Paper (and forks reporting like Paper, e.g. Pufferfish) | Plugins, `plugins/` | Paper builds |
| Folia | Plugins (Folia-compatible only) | Folia builds |
| Purpur, Spigot, CraftBukkit | Plugins | by hand |
| Fabric, Quilt | Mods, `mods/` | by hand |
| Forge, NeoForge | Mods, `mods/` | by hand |
| Vanilla | none (data packs live in the world) | by hand |

Mods are matched on Modrinth with the right loader, and their names come from `fabric.mod.json`, `quilt.mod.json` or `mods.toml`. The helper decides the add-on folder and checks a release's loaders itself, so a Fabric mod can't end up in `plugins/`. Set `MC_JAR` to the jar your unit starts if it isn't `paper.jar`.

## Notifications

Install the ntfy app, subscribe to a topic with a long, unguessable name (anyone who knows it can read it, or use a self-hosted ntfy with an access token), and paste the topic URL under **Server → Overview → Notifications**. Also set the **rconsole URL** (one click: *Use this address*); then:

- tapping a notification opens the matching page in rconsole, and an **Open rconsole** button is added; Android shows the rconsole icon,
- follow-ups replace the original notification instead of piling up: *server down* becomes *back up after 4 min*, *lagging* becomes *lag is over*, a player's *joined* becomes *left after 35 min*, and scanner sightings collect in one notification per day,
- each kind of alert has its own priority (min … urgent), and **quiet hours** deliver everything but urgent alerts silently,
- optional **one-tap actions** add buttons that act right away: *Ban &lt;ip&gt;* on scanner alerts and *Start server* when it is down. Each button holds a single-use link that works for 24 hours without signing in, so only turn this on for a private topic or one protected by an access token. Uses are recorded in the audit log as user `ntfy`.

Messages are published as JSON in plain text (the iOS app does not render Markdown). **Send test** shows what an alert looks like. Repeats of the same alert are held back for 10 minutes and there are at most 30 per hour.

## Prometheus

Set `METRICS_TOKEN` and scrape `/metrics`:

```yaml
scrape_configs:
  - job_name: minecraft
    scheme: https
    authorization: { credentials: <METRICS_TOKEN> }
    static_configs: [{ targets: ['rconsole.example.com'] }]
```

It exports up/TPS/MSPT/players, host CPU, memory and disk, the Minecraft process's memory and CPU, backup count, size, age and failure, and available Paper builds and rconsole commits.

## Map

1. Install squaremap under **Server → Plugins** and restart the server.
2. In `plugins/squaremap/config.yml` set `internal-webserver.bind: 127.0.0.1` and a free `port` (e.g. `8100`), so the map isn't public.
3. Add `MAP_URL=http://127.0.0.1:8100` to `/etc/rconsole.env` and restart rconsole.

The **Map** area then shows it. The map displays player-controlled text, so rconsole keeps it at arm's length: it runs in a sandbox with its own opaque origin (no access to rconsole's page, cookies or API), and the proxy accepts it through a per-session link instead of your session cookie. The link stops working when you sign out.

## Plugins

**Server → Plugins** lists every `.jar` and `.jar.disabled` in `plugins/`, reads its `plugin.yml`, and looks its SHA-512 up on Modrinth to show the project and any newer release for your Minecraft version and a Paper-compatible loader. Jars Modrinth doesn't know show as "Unknown source" and can still be disabled or removed.

- **Install / Update** download in `rconsole-net@` from Modrinth's CDN only and check the SHA-512 against the API. An update keeps the old jar in `plugins/.rconsole-previous/` for **Roll back**.
- **Disable** renames the jar to `.jar.disabled`; **Remove** moves it to `BACKUP_DIR/.plugin-trash/`. Plugin config folders are left alone.
- Every change applies on the next start; the "Restart to apply" bar lists what is waiting.

rconsole reads the jars through the `minecraft` group, so they need to be group-readable (`sudo chmod -R g+rX /srv/minecraft/plugins`).

## Upgrading from 1.x (rconsole-backup@ / rconsole-update@)

```sh
cd /opt/rconsole && git pull
sudo cp rconsole-job@.service rconsole-net@.service /etc/systemd/system/
sudo rm -f /etc/systemd/system/rconsole-backup@.service /etc/systemd/system/rconsole-update@.service
sudo cp 50-rconsole.rules /etc/polkit-1/rules.d/
sudo systemctl daemon-reload && sudo systemctl restart rconsole
```

Old `world-<date>.tar.gz` backups keep working; new ones are named after their world.

## Notes

- TPS uses `tps` on Paper/Spigot and `tick query` on vanilla 1.20.3+. Older vanilla versions show `n/a`.
- Backups archive the world folders (`level-name`, plus `_nether` and `_the_end` if present) as `.tar.gz`.
- Player avatars load from mc-heads.net.
