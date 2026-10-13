<p align="center">
  <img src="docs/logo.svg" width="72" height="72" alt="rconsole logo">
</p>

<h1 align="center">rconsole</h1>

<p align="center">
  <b>A self-hosted web console for your Minecraft server.</b><br>
  Live console, players, worlds, backups, updates, plugins and alerts in one fast, secure page, built for Paper, Spigot, Fabric, Forge and vanilla.
</p>

<p align="center">
  <a href="#quick-install"><img alt="Install in one command" src="https://img.shields.io/badge/install-one%20command-7c3aed"></a>
  <a href="https://github.com/iamozyth/rconsole/actions/workflows/test.yml"><img alt="Tests" src="https://github.com/iamozyth/rconsole/actions/workflows/test.yml/badge.svg"></a>
  <a href="https://github.com/iamozyth/rconsole/releases"><img alt="Latest release" src="https://img.shields.io/github/v/release/iamozyth/rconsole?color=7c3aed"></a>
  <img alt="Node.js 18+" src="https://img.shields.io/badge/node-%E2%89%A518-339933">
  <img alt="No dependencies" src="https://img.shields.io/badge/dependencies-0-brightgreen">
  <img alt="Paper, Purpur, Folia, Spigot, Fabric, Quilt, Forge, NeoForge, vanilla" src="https://img.shields.io/badge/servers-Paper%20%C2%B7%20Spigot%20%C2%B7%20Fabric%20%C2%B7%20Forge%20%C2%B7%20vanilla-555">
  <a href="LICENSE"><img alt="License: PolyForm Strict 1.0.0" src="https://img.shields.io/badge/license-PolyForm%20Strict-555"></a>
</p>

<p align="center">
  <a href="#quick-install">Quick install</a> ·
  <a href="#features">Features</a> ·
  <a href="#screenshots">Screenshots</a> ·
  <a href="#documentation">Documentation</a> ·
  <a href="#faq">FAQ</a>
</p>

<p align="center">
  <img src="docs/screenshots/console.webp" alt="rconsole: live server console with command autocomplete, online players and quick actions" width="900">
</p>

rconsole turns RCON and your server's own files into a polished admin panel. It installs next to an existing server in one command, needs nothing but Node.js, and keeps the server's files out of its reach: everything that changes them runs as the Minecraft user in sandboxed jobs.

> [!WARNING]
> **Early preview.** rconsole was written largely with an AI coding assistant (Claude Code), with a human steering, reviewing and testing it on a real Paper server. It has automated tests but no independent security review yet. Run it on a trusted network or behind a TLS proxy, keep your own backups, and expect breaking changes.

## Quick install

On a Debian or Ubuntu host where your Minecraft server already runs as a systemd service:

```sh
curl -fsSL https://raw.githubusercontent.com/iamozyth/rconsole/main/install.sh | sudo bash
```

Then open `http://<your-server>:8080` and sign in. The installer explains each step before it changes anything; [details below](#what-the-installer-does).

## Features

**Console and control**
- **Live console**: the server log as it happens, filterable, with a chat-and-joins view and a command prompt with history and **autocomplete** for commands, subcommands, players, game modes and game rules, including plugin commands.
- **Command palette** (Ctrl/⌘ K): jump anywhere, run any action, or type a Minecraft command.
- **Server power**: start, stop and restart with in-game countdowns; **maintenance mode** that lets only operators in and restores the whitelist afterwards.
- **Health at a glance**: TPS and MSPT, players, game time, CPU, memory, disk and uptime.

**Players and security**
- Whitelist, operators, bans and IP bans with one click.
- **Web chat**: follow chat, joins and leaves live, talk to everyone as **[Web] you**, whisper to a player, kick from a message.
- **Team roles**: admins, moderators (players, chat and moderation commands) and read-only viewers.
- **Player history** from your logs: sessions, playtime, last IP, daily activity.
- **Player profiles**: position, health, food, level and game mode, equipment, hotbar and inventory live (or as last saved when offline); statistics (play time, deaths, kills, distance, most mined and used) and advancements from the world files; teleport, game mode, heal, kick and clear inventory in one place.
- **Config editor** for plugin and mod configs: syntax checks, a diff before saving, one-click revert.
- **Scanner detection**: spots bots probing your server, explains what to do, and offers a ban or a ready-made firewall rule.

**Worlds and backups**
- Switch worlds, create new ones (seed and type), delete with an automatic archive.
- Per-world **backups** with autosave paused during the copy, retention, download, and **restore** over a world or as a new one.
- **Offsite copies** in any S3-compatible bucket (Backblaze B2, Cloudflare R2, AWS S3, Wasabi, MinIO), optionally encrypted before they leave the machine, uploaded after every backup.
- **Schedule** restarts, backups and commands, daily or weekly.

**Updates and plugins**
- **One check for everything**: rconsole itself, the server software and your plugins or mods.
- **Server updates** for Paper and Folia, SHA-256 verified. Players are warned, then disconnected; the world is backed up while nobody plays; the server starts on the new build. One-click rollback.
- **Plugins and mods from Modrinth**: identify installed jars, update with rollback, enable, disable, search and install, SHA-512 verified.
- **Settings editor** for `server.properties` with a review step; live where Minecraft allows it.
- **Self-update** with automatic rollback if the new version doesn't start.

**Insights and integrations**
- 24-hour and 7-day **charts** of TPS, players, CPU and memory, with downtime marked.
- **spark profiler**: one click starts a 30-second profile or a health report and links the result; rconsole offers to install spark if it's missing.
- **Problems**: crashes, out-of-memory, a hanging server, plugins that fail to load and other errors, found in the log, grouped, with the exception line and a push alert.
- **Log search** across `latest.log` and every rotated `.log.gz`.
- **Audit trail** of every change and sign-in.
- **Push notifications** through [ntfy](https://ntfy.sh): server down, lag, failed backups, updates, scanners, joins, with one-tap actions and quiet hours.
- **Discord**: the same alerts as embeds, and an optional relay of chat, joins and leaves into a channel.
- **Map**: squaremap or BlueMap inside rconsole, behind your sign-in.
- **Prometheus** `/metrics` endpoint.

**Works with** Paper, Purpur, Folia, Spigot, Bukkit, Fabric, Quilt, Forge, NeoForge and vanilla. rconsole detects the server software and adapts plugins, mods and updates to it.

**Secure by design**: accounts with scrypt hashes and optional TOTP 2FA, brute-force lockout, strict Content Security Policy, a sandboxed systemd service with read-only access to your server, and privileged work done only through fixed, validated helper jobs. See [Security model](#security-model).

## Screenshots

| | |
|---|---|
| <img src="docs/screenshots/updates.webp" alt="One check for rconsole, server software and plugin updates"><br><sub>**Updates**: one check for rconsole, the server and plugins</sub> | <img src="docs/screenshots/insights.webp" alt="TPS, players, CPU and memory charts"><br><sub>**Insights**: TPS, players, CPU and memory over 24 h or 7 days</sub> |
| <img src="docs/screenshots/security.webp" alt="Unknown connection attempts with ban and firewall options"><br><sub>**Security**: scanners spotted, with advice and one-click bans</sub> | <img src="docs/screenshots/worlds.webp" alt="Worlds and backups"><br><sub>**Worlds**: switch, create, back up and restore</sub> |
| <img src="docs/screenshots/settings.webp" alt="server.properties editor"><br><sub>**Settings**: `server.properties` as a typed form</sub> | <img src="docs/screenshots/palette.webp" alt="Command palette"><br><sub>**Command palette**: Ctrl/⌘ K for everything</sub> |
| <img src="docs/screenshots/players-light.webp" alt="Player history in the light theme"><br><sub>**Player history**, in the light theme</sub> | <img src="docs/screenshots/login.webp" alt="Sign-in page"><br><sub>**Sign-in** with optional two-step verification</sub> |

<p align="center">
  <img src="docs/screenshots/mobile.webp" alt="rconsole on a phone: console, players and server" width="720"><br>
  <sub>Made for phones too: every view works on a small screen.</sub>
</p>

## Requirements

- Linux with systemd: Debian or Ubuntu for the installer (developed on Debian); other distributions with the manual setup.
- Node.js 18 or newer (installed automatically if missing).
- A Minecraft server running as a systemd service under its own user. Java Edition: Paper, Purpur, Folia, Spigot, Bukkit, Fabric, Quilt, Forge, NeoForge or vanilla.
- RCON (the installer turns it on).

## FAQ

**How is rconsole different from Pterodactyl, Crafty Controller or AMP?**
Those are hosting panels: they install and run servers for you, often in containers, and bring their own databases and daemons. rconsole is the opposite: a single small Node.js process that attaches to the server you already run, with no database and no dependencies. It is for people who run one server (a homelab, friends, a community) and want a great console for it, not a hosting platform.

**How much does it take from the server?**
Very little. rconsole idles at about 70 MB of memory and well under 1% of one core. With the dashboard open it sends roughly ten RCON commands a minute (TPS every 10 s, the player list every 30 s or on a join or leave, the game time once a minute); a tab in the background sends none. Its systemd units give Minecraft priority: rconsole runs with a lower CPU and disk weight and a memory ceiling, and backups, restores and downloads only use what the server leaves over.

**Does it work with Bedrock?**
No. rconsole speaks Java Edition RCON and reads Java server files.

**Is it safe to expose to the internet?**
Put it behind a TLS reverse proxy (see [Traefik](#traefik)) or reach it over a VPN. Sign-ins have 2FA and brute-force protection, but rconsole is an admin tool: whoever signs in can run any server command.

**Can I use it for my business or hosting company?**
Not under the default license; see [License](#license) and ask for a commercial license.

## Documentation

- [What the installer does](#what-the-installer-does) · [Manual setup](#setup-on-debian-manual) · [Configuration](#configuration) · [Traefik / HTTPS](#traefik)
- [Updating rconsole](#updating) · [Server updates](#updates) · [Offsite backups](#offsite-backups) · [Plugins](#plugins) · [Server software](#server-software)
- [Insights](#insights) · [spark](#spark-profiler) · [Problems](#problems) · [Connection attempts](#connection-attempts) · [Notifications](#notifications) · [Prometheus](#prometheus) · [Map](#map)
- [Security model](#security-model) · [Upgrading from 1.x](#upgrading-from-1x-rconsole-backup--rconsole-update) · [Notes](#notes) · [License](#license)

## What the installer does

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

Other commands: `user list`, `user passwd <name>`, `user remove <name>`, `user role <name> <admin|moderator|viewer>`, `user totp-off <name>`. Add team members with a role: `user add <name> --role moderator`. Changes apply immediately, no restart needed.

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

The **Updates** tab has one **Check for updates** button for everything: rconsole itself, the server software (Paper and Folia builds and newer Minecraft versions), and plugins or mods from Modrinth. A server update keeps every player's progress:

1. players get the usual in-game countdown,
2. when it ends, everyone is disconnected and the server stops,
3. the world is backed up while nobody plays (optional, on by default),
4. the build is downloaded from PaperMC and its SHA-256 checked against the API,
5. the jar is swapped, keeping the old one as `paper.jar.previous`,
6. the server starts again, on the old jar if anything above failed.

Cancelling the countdown leaves everything as it was. Without control over the Minecraft service (no polkit rule) rconsole disconnects everyone, backs up with saving paused, swaps the jar and stops the server for systemd to restart.

**Roll back** swaps `paper.jar.previous` back in and restarts. That undoes a build update. A Minecraft version upgrade converts the world, so after one of those, only restoring the backup gets you back.

If a step fails, the UI shows the error. Details are in `journalctl -u 'rconsole-net@*'` or `journalctl -u 'rconsole-job@*'`.

## Player profiles

**Profile** on a player in the console's online list or in Players → History opens their profile:

- **live, while they're online** (read with `data get entity` over RCON): position, dimension, health, food, level, game mode, armor and offhand, hotbar (selected slot marked) and inventory, with counts and enchanted items highlighted;
- **last saved inventory** from the player's data file, for offline players (and as a fallback when the live reply can't be read);
- **statistics** from `<world>/players/stats/<uuid>.json` (Minecraft 26.1 and later; `<world>/stats/` before): play time, deaths, mob and player kills, distance walked, blocks mined, jumps, and the most mined, used and killed;
- **advancements** from `<world>/players/advancements/` (or `<world>/advancements/` before 26.1);
- **actions** by role: teleport to a player or coordinates, set the game mode (moderators and admins), heal and clear the inventory (admins), kick.

## Chat

Players → **Chat** shows chat messages, `/say` and `/me` lines, joins and leaves as they appear in the server log. Moderators and admins can write to everyone or whisper to one online player; the message appears in game as `[Web] <your name>: …` (sent with `tellraw`, so it can't run commands). Click a name to whisper; hover a message to whisper or kick. Viewers can read along.

## Offsite backups

Worlds → **Offsite copies** uploads backups to any S3-compatible bucket: Backblaze B2, Cloudflare R2, AWS S3, Wasabi, MinIO and others. Enter the endpoint (for example `https://s3.eu-central-003.backblazeb2.com` or `https://<account>.r2.cloudflarestorage.com`), bucket, region and an access key that may list, read, write and delete in that bucket; **Test connection** checks it.

- **Encryption:** with a passphrase, every backup is encrypted on this machine (AES-256-GCM in 1 MiB chunks, key derived with scrypt) before upload and stored as `<backup>.tar.gz.enc`. Keep the passphrase somewhere safe: without it the copies can't be restored.
- **Automatic uploads** after every backup (scheduled or manual), one at a time with retries after 1, 5 and 30 minutes; a final failure sends a "backup" notification. Any backup can also be uploaded with **Upload**.
- **Retention:** the newest *n* copies of each world are kept in the bucket (default 14, 0 keeps all).
- **Restore:** **Bring back** downloads (and decrypts) a copy into the backup folder; restore it from there as usual.

Settings live in `/var/lib/rconsole/offsite.json` (mode 600; secrets are never sent back to the browser). They can also come from the environment: `OFFSITE_ENDPOINT`, `OFFSITE_REGION`, `OFFSITE_BUCKET`, `OFFSITE_ACCESS_KEY_ID`, `OFFSITE_SECRET_ACCESS_KEY`, `OFFSITE_PASSPHRASE`.

## Insights

- **Metrics** are sampled every 30 seconds while rconsole runs: TPS/MSPT, players online, host CPU and memory, and the Minecraft process's CPU and RSS (from `/proc/<MainPID>`, so it needs `MC_SERVICE` to be readable via `systemctl show`). 24 hours are kept at full resolution and 7 days as 5-minute averages, in `/var/lib/rconsole/metrics.json`.
- **Player history** is rebuilt from `logs/latest.log` and `logs/*.log.gz`. What has been read from rotated logs is cached in `/var/lib/rconsole/players.json`, so history survives old logs being deleted. Log lines only carry a time of day; dates come from the rotated file names and the last write of `latest.log`.
- **Log search** reads newest first and stops at 500 matches or after 8 seconds; use the date range to reach further back.

## spark profiler

When TPS drops, [spark](https://spark.lucko.me) shows which plugin, mod, entity or chunk the server spends its time on. Insights → Metrics has **Profile 30 s** and **Health report**; rconsole starts them over RCON and shows the viewer link when spark has uploaded it (read from spark's `activity.json`, since spark answers RCON asynchronously). Earlier results are listed too. Without spark, **Install spark** installs it from Modrinth (it loads at the next restart).

## Problems

Insights → **Problems** lists what went wrong in the last 24 hours or 7 days, read from `latest.log` and the rotated logs:

- **critical:** crashes (crash reports, exceptions in the tick loop), `OutOfMemoryError`, the watchdog's "server has stopped responding", and stops that systemd reports as failed (for example the kernel's OOM killer) even when the log shows nothing;
- **errors:** plugins or mods that fail to load or enable, exceptions in plugin events and tasks, and any other ERROR line;
- **warnings:** "Can't keep up", with the worst delay.

Repeats are grouped (numbers, UUIDs and names don't split a group), with the plugin, the exception line from the stack trace, counts and times, and a jump into log search. New errors put a red dot on Insights until you mark them as seen. With notifications on, crashes and plugin failures alert at once, other errors arrive as one daily digest.

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
- each kind of alert has its own priority (min … urgent) that applies to all its messages (joined and left, down and back up), and **quiet hours** deliver everything but urgent alerts silently,
- optional **one-tap actions** add buttons that act right away: *Ban &lt;ip&gt;* on scanner alerts and *Start server* when it is down. Each button holds a single-use link that works for 24 hours without signing in, so only turn this on for a private topic or one protected by an access token. Uses are recorded in the audit log as user `ntfy`.

Messages are published as JSON in plain text (the iOS app does not render Markdown). **Send test** shows what an alert looks like. Repeats of the same alert are held back for 10 minutes and there are at most 30 per hour.

### Discord

Under Server → Notifications → **Discord**, paste a channel webhook (channel settings → Integrations → Webhooks → Copy Webhook URL):

- **Alerts**: the same alerts as ntfy (each with its on/off switch), as embeds coloured by priority and linking to rconsole. Discord works with or without ntfy.
- **Chat**: a second webhook mirrors chat, `/say`, joins and leaves into a channel, batched every few seconds and within Discord's rate limits.

Mentions are switched off, so nobody in game can ping `@everyone`. Webhook URLs are stored like the ntfy token and never sent back to the browser. Messages from Discord into Minecraft would need a bot and aren't supported.

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

## Plugin configs

**Server → Configs** (admins) lists the text config files under `plugins/` (Paper, Spigot, Purpur, Folia) or `config/` (Fabric, Quilt, Forge, NeoForge): `.yml .yaml .json .json5 .properties .toml .conf .cfg .txt`, up to 512 KB each.

- The editor checks the syntax as you type (JSON must parse; YAML can't be indented with tabs) and shows a line diff before saving.
- Saving runs in `rconsole-job@` as the `minecraft` user: it re-checks the path (no links, no `..`, only existing files), keeps the old version in `.rconsole-previous/`, and writes atomically. **Revert** puts the previous version back.
- Most plugins pick up changes with their own reload command; otherwise restart. The change is added to the "Restart to apply" bar.
- Saved contents never go into the audit log, only the file name.

## Upgrading from 1.x (rconsole-backup@ / rconsole-update@)

```sh
cd /opt/rconsole && git pull
sudo cp rconsole-job@.service rconsole-net@.service /etc/systemd/system/
sudo rm -f /etc/systemd/system/rconsole-backup@.service /etc/systemd/system/rconsole-update@.service
sudo cp 50-rconsole.rules /etc/polkit-1/rules.d/
sudo systemctl daemon-reload && sudo systemctl restart rconsole
```

Old `world-<date>.tar.gz` backups keep working; new ones are named after their world.

## Security model

- **Accounts** live in `/var/lib/rconsole/users.json` with scrypt password hashes. They're managed with `cli.js` on the server only; there is no web signup.
- **Roles**: `admin` (everything; accounts from before roles existed are admins), `moderator` (sees everything an admin sees except the audit log and notification and offsite settings; runs only moderation commands: say, tell, kick, ban and pardon, whitelist add and remove, tp, gamemode, spectate and common mute or warn plugin commands) and `viewer` (read-only: console, charts, settings, no player addresses). The server enforces the role on every request; the interface hides what a role can't do. `node cli.js user add <name> --role moderator`, `node cli.js user role <name> viewer`; changing a role signs that user out.
- **Sessions** are random 256-bit tokens in an `HttpOnly`, `SameSite=Strict` cookie, `Secure` when served over HTTPS. They expire after 12 h idle or 7 days, and are revoked when the password changes or the user is removed. Sessions are kept in memory, so restarting rconsole signs everyone out.
- **2FA**: optional TOTP per user, with replay protection.
- **Brute force**: 5 failed logins per client IP or per username within 15 minutes lock that IP or name for 15 minutes.
- **Cross-site requests**: state-changing requests must be same-origin and JSON.
- **Audit**: every state-changing request, sign-in (including failed ones), scheduled task and background operation is recorded with user, IP and outcome in `/var/lib/rconsole/audit.jsonl` (rotated at 5 MB, passwords and codes never stored) and shown under Insights → Audit. The same events also go to `journalctl -u rconsole`.
- **Process**: runs as its own `rconsole` user with read-only access to the Minecraft directory, write access only to its state and backup directories, and only the capability to bind port 80.
- **Privileged jobs**: anything that writes to the Minecraft directory (backups, restores, world changes, `server.properties`, jar updates) runs as the Minecraft user in sandboxed systemd units, `rconsole-job@` (no network) and `rconsole-net@` (downloads), executing the fixed script `bin/mc-helper.js`. rconsole only drops a request file; the helper validates it again (typed allowlist for `server.properties`, safe names, archives checked for links and stray paths) and keeps every path inside the server and backup directories. RCON and port settings can't be changed from rconsole.
- **polkit** lets the `rconsole` user start exactly these job units and start/stop/restart `minecraft.service`, nothing else. Signed-in users are full admins: RCON commands and plugin installs (from Modrinth) run with the Minecraft server's rights by design. rconsole itself can't make the helper write outside its fixed job types, and updates only install downloads whose hash matches the publisher's API.

rconsole speaks plain HTTP. Put it behind a TLS reverse proxy (see Traefik below) and set `TRUST_PROXY` to the proxy's IP, so client IPs and `Secure` cookies are correct. For defence in depth, firewall port 80 so only the proxy can reach it.

## Notes

- TPS uses `tps` on Paper/Spigot and `tick query` on vanilla 1.20.3+. Older vanilla versions show `n/a`.
- Backups archive the world folders (`level-name`, plus `_nether` and `_the_end` if present) as `.tar.gz`.
- Player avatars load from mc-heads.net.

## License

rconsole is licensed under the [PolyForm Strict License 1.0.0](LICENSE) ([polyformproject.org](https://polyformproject.org/licenses/strict/1.0.0)). It is source-available, not open source:

- **Allowed:** using it for personal and other noncommercial purposes, and use by noncommercial organisations (charities, schools, public institutions), as the license defines them.
- **Not allowed:** changing it or building on it, redistributing it, or any commercial use, such as running it for a business or offering it as a (hosted) service.

For commercial use or anything else beyond these terms, ask for a separate license via [winterstetter.io](https://winterstetter.io).

Versions up to commit `7f7683a` were published under the MIT License. The fonts in `public/fonts` (Inter, JetBrains Mono) remain under the SIL Open Font License 1.1; see the license files next to them.
