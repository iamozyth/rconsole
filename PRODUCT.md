# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

One person: the homelab owner who runs a Paper Minecraft server for a small group of friends. They are the only rconsole user and full admin. They check in from a desktop browser for longer sessions (reading logs, managing backups, updating) and from a phone for quick actions (restart, whitelist a friend, see who is online).

## Product Purpose

rconsole is a self-hosted web console for operating a single Minecraft server over RCON, so the owner never needs an SSH session for routine work. Success: every routine task — run a command, read the live log, manage whitelist/ops/bans, take and download backups, schedule restarts and backups, update Paper — is done from the browser, safely, in seconds.

## Positioning

A private, single-server operator console that runs next to the server and does real operations (backups as the Minecraft user, SHA-256 verified Paper updates, countdown restarts) instead of only relaying RCON commands. Not a hosting panel, not multi-tenant.

## Operating Context

- Runs on a Debian VM (`vm-debian-01`) as its own sandboxed `rconsole` systemd service on port 80, behind Traefik with TLS at `rconsole.hq.winterstetter.io`. LAN/VPN only; only the Minecraft port is exposed to the internet.
- Minecraft: Paper 26.x, `minecraft` user, `/srv/minecraft`, RCON on 127.0.0.1:25575, restarted by systemd after `stop`.
- Backups in `/srv/minecraft-backups`; privileged jobs run via `rconsole-backup@` / `rconsole-update@` units started through a polkit rule.
- Sign-in with a local account and TOTP 2FA.

## Capabilities and Constraints

- Tabs: Console (live `latest.log` stream, command prompt with history, quick actions, restart with countdown), Players (whitelist + toggle, ops, banned players, banned IPs), Backups (create, download, delete, retention), Schedule (daily/weekly restart/backup/command tasks), Updates (Paper builds and Minecraft versions, rollback).
- Header status: RCON connection, TPS/MSPT, players online/max, in-game time, host CPU/RAM/disk/uptime.
- Zero runtime dependencies: Node.js stdlib server, static HTML/CSS/JS, no build step, no framework, no external fonts or CDNs. Strict CSP: `script-src 'self'`, `style-src 'self'`, images only from self and `mc-heads.net` (player avatars).
- Single admin role; no user management in the UI (CLI only).

## Brand Commitments

Name "rconsole" (lowercase). No logo or brand assets exist yet.

## Evidence on Hand

No marketing content, testimonials or metrics; this is an internal tool. Do not invent any.

## Product Principles

1. Safe by default: destructive or disruptive actions (ban, stop, restart, update, delete) are explicit, confirmed, and reversible where possible.
2. State is always visible: connection, running jobs, countdowns and failures are never hidden or ambiguous.
3. Fast for the expert: dense, keyboard-friendly, no hand-holding for a single experienced operator.
4. Works on a phone: the quick tasks must be comfortable one-handed.
