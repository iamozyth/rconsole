# rconsole

A minimal web console for managing a Minecraft server over RCON. One file, no dependencies, Node.js 18+.

- Live command console with history (↑/↓)
- Online player list, refreshed every 10 s
- Buttons for common actions: whitelist, op, gamemode, kick, ban, time, weather, save, stop
- HTTP Basic auth, binds to localhost by default

## 1. Enable RCON on the Minecraft server

In `server.properties`, then restart the server:

```properties
enable-rcon=true
rcon.port=25575
rcon.password=change-me
```

Do **not** open port 25575 in your firewall. RCON is unencrypted. Only expose rconsole.

## 2. Run

```sh
RCON_PASSWORD=change-me WEB_PASSWORD=another-secret npm start
```

Open http://127.0.0.1:8080 and log in as `admin` with `WEB_PASSWORD`.

| Variable        | Default     | Description                      |
|-----------------|-------------|----------------------------------|
| `RCON_PASSWORD` | (required)  | Matches `rcon.password`          |
| `WEB_PASSWORD`  | (required)  | Password for the web UI          |
| `WEB_USER`      | `admin`     | Username for the web UI          |
| `RCON_HOST`     | `127.0.0.1` | Minecraft server host            |
| `RCON_PORT`     | `25575`     | RCON port                        |
| `WEB_HOST`      | `127.0.0.1` | Address the web UI binds to      |
| `WEB_PORT`      | `8080`      | Port the web UI listens on       |

## Remote access

Basic auth over plain HTTP sends your password in the clear. To reach rconsole from elsewhere, keep it on localhost and either use an SSH tunnel:

```sh
ssh -L 8080:127.0.0.1:8080 you@your-server
```

or put it behind a TLS reverse proxy, for example Caddy:

```
rcon.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

## systemd

`/etc/systemd/system/rconsole.service`:

```ini
[Unit]
Description=rconsole
After=network.target

[Service]
WorkingDirectory=/opt/rconsole
ExecStart=/usr/bin/node server.js
Environment=RCON_PASSWORD=change-me
Environment=WEB_PASSWORD=another-secret
Restart=on-failure
User=minecraft

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl enable --now rconsole
```
