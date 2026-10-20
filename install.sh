#!/bin/bash
# rconsole installer for an existing Minecraft server on Debian/Ubuntu.
#
#   curl -fsSL https://raw.githubusercontent.com/iamozyth/rconsole/main/install.sh | sudo bash
#   sudo ./install.sh [options]          # from a checkout
#
# With --new (or when no server is found) it sets rconsole up to install
# and run servers itself: users, folders, units and polkit, and you create
# the first server in the browser under Server -> Servers.
#
# Otherwise it finds the server (systemd unit, folder, user, jar, server software),
# installs what is missing (Node.js 24 from NodeSource, git, polkit), turns on RCON if needed,
# sets up users, permissions, the backup folder, the systemd units and the
# polkit rule, writes /etc/rconsole.env, starts rconsole and creates the
# first account. Safe to run again: it only changes what isn't set up yet.
#
# Options:
#   --mc-dir DIR        Minecraft server folder (contains server.properties)
#   --service NAME      systemd unit running the server (e.g. minecraft.service)
#   --backup-dir DIR    where backups go (default: <mc-dir>-backups or /srv/minecraft-backups)
#   --host ADDR         address rconsole listens on (default 0.0.0.0)
#   --port N            port rconsole listens on (default 8080)
#   --admin NAME        first account (asked for if missing)
#   --new               no existing server: rconsole installs and runs servers itself
#   --yes               don't ask; use detected values and defaults
#   --dry-run           show what would be done, change nothing
#   --uninstall         stop and remove rconsole (keeps backups and /var/lib/rconsole)
#
# Everything is inside main() so a piped download runs only when complete.

main() {
  set -euo pipefail
  local REPO="${RCONSOLE_REPO_URL:-https://github.com/iamozyth/rconsole.git}"
  local DIR="${RCONSOLE_DIR:-/opt/rconsole}" ENV_FILE="${RCONSOLE_ENV:-/etc/rconsole.env}"
  local UNIT_DIR="${SYSTEMD_DIR:-/etc/systemd/system}" POLKIT_DIR="${POLKIT_DIR:-/etc/polkit-1/rules.d}"
  local MC_DIR="" MC_SERVICE="" BACKUP_DIR="" SERVERS_DIR="/srv/minecraft-servers" MC_USER="" MC_GROUP="" MC_JAR="" WEB_HOST="0.0.0.0" WEB_PORT="8080"
  local ADMIN="" YES=0 DRY=0 UNINSTALL=0 RESTART_MC=0 NEW=0
  local -a CHANGES=() NOTES=()

  # --- output ----------------------------------------------------------------
  local B="" D="" G="" Y="" R="" N=""
  if [ -t 1 ]; then B=$'\e[1m'; D=$'\e[2m'; G=$'\e[32m'; Y=$'\e[33m'; R=$'\e[31m'; N=$'\e[0m'; fi
  step() { printf '\n%s==>%s %s%s%s\n' "$G" "$N" "$B" "$*" "$N"; }
  info() { printf '    %s\n' "$*"; }
  warn() { printf '    %s!%s %s\n' "$Y" "$N" "$*"; NOTES+=("$*"); }
  die() { printf '\n%serror:%s %s\n' "$R" "$N" "$*" >&2; exit 1; }
  changed() { CHANGES+=("$*"); printf '    %s+%s %s\n' "$G" "$N" "$*"; }
  # run CMD...: executes, or only prints it in --dry-run
  run() { if [ "$DRY" = 1 ]; then printf '    %s[dry-run]%s %s\n' "$D" "$N" "$*"; else "$@"; fi; }
  # ask "question" default -> answer (from the terminal even when piped)
  ask() {
    local q="$1" def="${2:-}" a=""
    if [ "$YES" = 1 ] || [ ! -r /dev/tty ]; then printf '%s' "$def"; return; fi
    printf '    %s%s%s [%s]: ' "$B" "$q" "$N" "$def" > /dev/tty
    read -r a < /dev/tty || true
    printf '%s' "${a:-$def}"
  }
  confirm() { local a; a="$(ask "$1 (y/n)" "${2:-y}")"; [[ "$a" =~ ^[YyJj] ]]; }

  while [ $# -gt 0 ]; do
    case "$1" in
      --mc-dir) MC_DIR="$2"; shift ;;
      --service) MC_SERVICE="$2"; shift ;;
      --backup-dir) BACKUP_DIR="$2"; shift ;;
      --host) WEB_HOST="$2"; shift ;;
      --port) WEB_PORT="$2"; shift ;;
      --admin) ADMIN="$2"; shift ;;
      --yes|-y) YES=1 ;;
      --new) NEW=1 ;;
      --dry-run) DRY=1 ;;
      --uninstall) UNINSTALL=1 ;;
      -h|--help) sed -n '2,30p' "$0" 2>/dev/null || true; exit 0 ;;
      *) die "unknown option $1 (see --help)" ;;
    esac
    shift
  done

  printf '%srconsole installer%s\n' "$B" "$N"
  [ "$(id -u)" = 0 ] || [ "$DRY" = 1 ] || die "run as root (sudo)."
  command -v systemctl >/dev/null || die "systemd is required."

  if [ "$UNINSTALL" = 1 ]; then
    step "Removing rconsole"
    run systemctl disable --now rconsole.service 2>/dev/null || true
    run systemctl disable rconsole-limits.service 2>/dev/null || true
    for f in rconsole.service rconsole-job@.service rconsole-net@.service rconsole-selfupdate.service rconsole-limits.service rconsole-mc@.service rconsole-mc@.socket; do run rm -f "$UNIT_DIR/$f"; done
    run rm -rf "$UNIT_DIR"/rconsole-mc@*.service.d/50-rconsole-limits.conf
    command -v nft >/dev/null && run nft delete table inet rconsole 2>/dev/null || true
    run rm -f "$POLKIT_DIR/50-rconsole.rules"
    run systemctl daemon-reload
    info "Removed the services and the polkit rule. Kept: $DIR, $ENV_FILE, /var/lib/rconsole and your backups."
    info "Delete those by hand if you want them gone. Your Minecraft server is unchanged."
    return 0
  fi

  # --- find the Minecraft server -------------------------------------------
  step "Looking for your Minecraft server"
  local candidates=() unit wd
  if [ -z "$MC_SERVICE" ] || [ -z "$MC_DIR" ]; then
    # Services whose working directory holds a server.properties.
    while read -r unit; do
      wd="$(systemctl show "$unit" -p WorkingDirectory --value 2>/dev/null || true)"
      wd="${wd#!}"
      if [ -n "$wd" ] && [ -f "$wd/server.properties" ]; then
        if [ -z "$MC_DIR" ] || [ "$MC_DIR" = "$wd" ]; then candidates+=("$unit|$wd"); fi
      fi
    done < <(systemctl list-unit-files --type=service --no-legend 2>/dev/null | awk '{print $1}' | grep -v '@\.service$' | grep -Ev '^(rconsole|systemd-|dbus|getty|user@)')
  fi
  if [ -z "$MC_SERVICE" ] && [ "${#candidates[@]}" -ge 1 ]; then
    if [ "${#candidates[@]}" -gt 1 ]; then
      info "Several services run a Minecraft server:"
      local i=1; for c in "${candidates[@]}"; do info "  $i) ${c%%|*}  (${c#*|})"; i=$((i + 1)); done
      local pick; pick="$(ask "Which one?" 1)"
      [[ "$pick" =~ ^[0-9]+$ ]] && [ "$pick" -ge 1 ] && [ "$pick" -le "${#candidates[@]}" ] || die "no such choice"
      candidates=("${candidates[$((pick - 1))]}")
    fi
    MC_SERVICE="${candidates[0]%%|*}"
    [ -n "$MC_DIR" ] || MC_DIR="${candidates[0]#*|}"
  fi
  if [ -z "$MC_DIR" ] && [ "$NEW" = 0 ]; then
    for d in /srv/minecraft /opt/minecraft /var/lib/minecraft /home/minecraft /home/*/minecraft /home/*/server /srv/*; do
      [ -f "$d/server.properties" ] && { MC_DIR="$d"; break; }
    done
    if [ -z "$MC_DIR" ] && [ -z "$MC_SERVICE" ]; then
      info "No Minecraft server found on this machine."
      if confirm "Set rconsole up to install and run servers itself?" y; then NEW=1
      else die "stopped. Pass --mc-dir/--service for an existing server."; fi
    fi
  fi
  if [ "$NEW" = 1 ]; then
    MC_USER=minecraft; MC_GROUP=minecraft; MC_DIR=/srv/minecraft; MC_SERVICE=minecraft.service; MC_JAR=paper.jar
    [ -n "$BACKUP_DIR" ] || BACKUP_DIR=/srv/minecraft-backups
    info "Servers:       $B$SERVERS_DIR$N (installed by rconsole, run as $MC_USER)"
    info "Backups:       $BACKUP_DIR"
    confirm "Set up rconsole?" y || die "stopped."
  else
  [ -n "$MC_DIR" ] || MC_DIR="$(ask "Minecraft server folder (with server.properties)" "")"
  MC_DIR="${MC_DIR%/}"
  [ -f "$MC_DIR/server.properties" ] || die "no server.properties in '$MC_DIR'. Start the server once, or pass --mc-dir."
  if [ -z "$MC_SERVICE" ]; then
    MC_SERVICE="$(ask "systemd service that runs it" "minecraft.service")"
  fi
  [[ "$MC_SERVICE" == *.service ]] || MC_SERVICE="$MC_SERVICE.service"
  systemctl cat "$MC_SERVICE" >/dev/null 2>&1 || die "systemd doesn't know $MC_SERVICE. rconsole needs the server to run as a systemd service (see README: Running Minecraft as a service)."

  MC_USER="$(systemctl show "$MC_SERVICE" -p User --value 2>/dev/null || true)"
  MC_GROUP="$(systemctl show "$MC_SERVICE" -p Group --value 2>/dev/null || true)"
  [ -n "$MC_USER" ] || MC_USER="$(stat -c %U "$MC_DIR")"
  [ -n "$MC_GROUP" ] || MC_GROUP="$(id -gn "$MC_USER" 2>/dev/null || stat -c %G "$MC_DIR")"
  [ "$MC_USER" != root ] || die "$MC_SERVICE runs as root. Run Minecraft as its own user first; rconsole keeps the two apart."
  local exec_start; exec_start="$(systemctl show "$MC_SERVICE" -p ExecStart --value 2>/dev/null || true)"
  MC_JAR="$(grep -oE -- '-jar [^ ;]+' <<<"$exec_start" | head -1 | awk '{print $2}' || true)"
  MC_JAR="$(basename "${MC_JAR:-paper.jar}")"
  local software="unknown"
  if [ -r "$MC_DIR/logs/latest.log" ]; then
    software="$(head -c 262144 "$MC_DIR/logs/latest.log" | grep -oE 'running (Paper|Folia|Purpur|[A-Za-z]+) version [0-9.]+|with (Fabric|Quilt) Loader [0-9.]+|neoforge|forge|Starting minecraft server version [0-9.]+' | head -1 || true)"
  fi
  [ -n "$BACKUP_DIR" ] || BACKUP_DIR="$([ "$MC_DIR" = /srv/minecraft ] && echo /srv/minecraft-backups || echo "${MC_DIR}-backups")"
  info "Server folder: $B$MC_DIR$N"
  info "Service:       $B$MC_SERVICE$N (runs as $MC_USER:$MC_GROUP, jar $MC_JAR)"
  info "Software:      ${software:-unknown}"
  info "Backups:       $BACKUP_DIR"
  confirm "Set up rconsole for this server?" y || die "stopped. Pass --mc-dir/--service to pick another server."
  fi

  # --- dependencies ----------------------------------------------------------
  step "Checking dependencies"
  local pkgs=()
  command -v git >/dev/null || pkgs+=(git)
  command -v tar >/dev/null || pkgs+=(tar)
  # zstd: faster backups (shorter autosave pause); nftables: the RCON firewall.
  command -v zstd >/dev/null || pkgs+=(zstd)
  command -v nft >/dev/null || [ -x /usr/sbin/nft ] || pkgs+=(nftables)
  if [ ! -x /usr/lib/polkit-1/polkitd ] && [ ! -x /usr/libexec/polkitd ]; then
    pkgs+=("$(apt-cache show polkitd >/dev/null 2>&1 && echo polkitd || echo policykit-1)")
  fi
  if [ "${#pkgs[@]}" -gt 0 ]; then
    command -v apt-get >/dev/null || die "please install: ${pkgs[*]}"
    run apt-get update -qq
    run env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${pkgs[@]}"
    changed "installed ${pkgs[*]}"
  else
    info "git, tar, zstd, nftables and polkit are present."
  fi

  # --- code --------------------------------------------------------------------
  step "Getting rconsole"
  if [ -d "$DIR/.git" ]; then
    info "$DIR is already a checkout; update it from the web UI or with 'git pull'."
  else
    local here; here="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
    if [ -n "$here" ] && [ -f "$here/server.js" ] && [ -d "$here/.git" ] && [ "$here" != "$DIR" ]; then
      run git clone -q "$here" "$DIR"
      run git -C "$DIR" remote set-url origin "$(git -C "$here" remote get-url origin 2>/dev/null || echo "$REPO")"
    else
      run git clone -q "$REPO" "$DIR"
    fi
    changed "cloned rconsole into $DIR"
  fi
  # Templates and helpers come from the checkout (or, in a dry run before
  # the clone, from the folder this script is in).
  local SRC="$DIR"
  if [ ! -f "$SRC/bin/units.sh" ]; then
    SRC="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
    [ -f "$SRC/bin/units.sh" ] || die "$DIR doesn't look like rconsole (no bin/units.sh)."
  fi
  # shellcheck source=bin/units.sh
  source "$SRC/bin/units.sh"

  # --- Node.js -------------------------------------------------------------------
  # Debian's and Ubuntu's own nodejs is too old (Debian 12: 18, Debian 13:
  # 20), so it comes from NodeSource's repository unless a new enough node
  # is already installed.
  step "Node.js"
  # shellcheck source=bin/node.sh
  source "$SRC/bin/node.sh"
  local NODE_BIN node_need node_have
  node_need="$(node_required "$SRC")"
  NODE_BIN="$(command -v node || echo /usr/bin/node)"
  node_have="$(node_major "$NODE_BIN")"
  if [ "$node_have" -ge "$node_need" ]; then
    info "Node.js $("$NODE_BIN" -v) ($NODE_BIN)"
  else
    command -v apt-get >/dev/null || die "rconsole needs Node.js $node_need or newer$([ "$node_have" = 0 ] || echo ", this system has v$node_have"). Install it and run the installer again."
    run install_nodesource "$node_need" || die "couldn't install Node.js $node_need from NodeSource (see above). Install Node.js $node_need or newer by hand and run the installer again."
    NODE_BIN="$NODESOURCE_BIN"
    changed "installed Node.js $([ "$DRY" = 1 ] && echo "$node_need" || "$NODE_BIN" -v) from NodeSource$([ "$node_have" = 0 ] || echo " (was v$node_have)")"
  fi

  # --- users and permissions ---------------------------------------------------
  step "Users and permissions"
  if [ "$NEW" = 1 ]; then
    if id "$MC_USER" >/dev/null 2>&1; then info "user $MC_USER exists"
    else run useradd --system --user-group --home-dir "$SERVERS_DIR" --no-create-home --shell /usr/sbin/nologin "$MC_USER"; changed "created system user $MC_USER (runs the servers)"; fi
    # The job units expect MC_DIR to exist; with --new it stays empty.
    [ -d "$MC_DIR" ] || { run install -d -o "$MC_USER" -g "$MC_GROUP" -m 2750 "$MC_DIR"; changed "created $MC_DIR"; }
  fi
  if id rconsole >/dev/null 2>&1; then info "user rconsole exists"
  else run useradd --system --no-create-home --shell /usr/sbin/nologin rconsole; changed "created system user rconsole"; fi
  # rconsole reads the server folder through the server's group.
  local unreadable; unreadable="$(find "$MC_DIR" -maxdepth 3 \( -type d ! -perm -g+rx -o -type f ! -perm -g+r \) -print -quit 2>/dev/null || true)"
  if [ -n "$unreadable" ] || [ "$(stat -c %G "$MC_DIR")" != "$MC_GROUP" ]; then
    run chgrp -R "$MC_GROUP" "$MC_DIR"
    run chmod -R g+rX "$MC_DIR"
    changed "made $MC_DIR readable for group $MC_GROUP"
  fi
  if [ ! -d "$BACKUP_DIR" ]; then
    run mkdir -p "$BACKUP_DIR"
    changed "created $BACKUP_DIR"
  fi
  run chown "$MC_USER:$MC_GROUP" "$BACKUP_DIR"
  run chmod 2770 "$BACKUP_DIR"
  # Servers rconsole installs itself: written by the Minecraft user (helper
  # jobs, the servers), readable for rconsole through the group.
  if [ ! -d "$SERVERS_DIR" ]; then
    run install -d -o "$MC_USER" -g "$MC_GROUP" -m 2750 "$SERVERS_DIR"
    changed "created $SERVERS_DIR"
  fi

  local pass="" port=""
  if [ "$NEW" = 0 ]; then
  # --- Minecraft service: restart policy, umask ------------------------------
  step "Minecraft service"
  local dropin="$UNIT_DIR/$MC_SERVICE.d/50-rconsole.conf" restart umask lines=()
  restart="$(systemctl show "$MC_SERVICE" -p Restart --value 2>/dev/null || echo no)"
  umask="$(systemctl show "$MC_SERVICE" -p UMask --value 2>/dev/null || echo 0022)"
  # rconsole restarts the server by sending "stop"; systemd brings it back.
  [ "$restart" = always ] || [ "$restart" = on-failure ] || [ "$restart" = on-abnormal ] || lines+=("Restart=always" "RestartSec=10")
  # New files must stay readable for rconsole (group).
  [ "$umask" != 0077 ] || lines+=("UMask=0027")
  if [ -f "$dropin" ]; then info "$dropin is in place"; lines=(); fi
  # When memory runs out, the kernel stops Minecraft before rconsole or sshd.
  local oom="$UNIT_DIR/$MC_SERVICE.d/55-rconsole-oom.conf"
  if [ ! -f "$oom" ] && [ "$(systemctl show "$MC_SERVICE" -p OOMScoreAdjust --value 2>/dev/null || echo 0)" = 0 ]; then
    if [ "$DRY" = 1 ]; then info "[dry-run] write $oom: OOMScoreAdjust=500"
    else mkdir -p "$(dirname "$oom")"; printf '# Added by the rconsole installer.\n[Service]\nOOMScoreAdjust=500\n' > "$oom"; fi
    changed "set OOMScoreAdjust=500 on $MC_SERVICE (applies at its next restart)"
  fi
  # Opt-in sandbox like rconsole's own servers get: only its folder writable,
  # the backups and rconsole's servers hidden. Only for a plain java command
  # line: screen, tmux or scripts need more than the sandbox allows.
  local sandbox="$UNIT_DIR/$MC_SERVICE.d/60-rconsole-sandbox.conf"
  if [ -f "$sandbox" ]; then info "$sandbox is in place"
  elif grep -oE 'argv\[\]=[^;]*' <<<"$exec_start" | head -1 | grep -qE '(=|/)java ' && ! grep -qE 'screen|tmux|/bin/(ba)?sh|\.sh( |;|$)' <<<"$exec_start"; then
    if confirm "Sandbox $MC_SERVICE (only $MC_DIR writable, backups hidden; may break plugins that write elsewhere)?" n; then
      if [ "$DRY" = 1 ]; then info "[dry-run] write $sandbox"
      else
        mkdir -p "$(dirname "$sandbox")"
        render_unit < "$SRC/minecraft-sandbox.conf" > "$sandbox"
        # A server folder under /home needs /home.
        case "$MC_DIR" in /home/*|/root/*) sed -i 's/^ProtectHome=true$/ProtectHome=false/' "$sandbox" ;; esac
      fi
      changed "sandboxed $MC_SERVICE (remove $sandbox to undo; applies at its next restart)"
    fi
  fi
  if [ "${#lines[@]}" -gt 0 ]; then
    if [ "$DRY" = 1 ]; then info "[dry-run] write $dropin: ${lines[*]}"
    else
      mkdir -p "$(dirname "$dropin")"
      printf '# Added by the rconsole installer.\n[Service]\n%s\n' "$(printf '%s\n' "${lines[@]}")" > "$dropin"
    fi
    changed "set ${lines[*]} on $MC_SERVICE (applies at its next restart)"
  else info "restart policy and umask are fine"; fi

  # --- RCON --------------------------------------------------------------------
  step "RCON"
  local props="$MC_DIR/server.properties" enabled
  prop() { grep -E "^$1=" "$props" | tail -1 | cut -d= -f2- | sed 's/\\//g' || true; }
  enabled="$(prop enable-rcon)"; pass="$(prop 'rcon\.password')"; port="$(prop 'rcon\.port')"
  if [ "$enabled" != true ] || [ -z "$pass" ]; then
    [ -n "$pass" ] || pass="$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 32)"
    [ -n "$port" ] || port=25575
    if [ "$DRY" = 1 ]; then info "[dry-run] set enable-rcon=true, rcon.port=$port and a generated rcon.password in $props"
    else
      cp -p "$props" "$props.before-rconsole"
      RCON_PASSWORD_NEW="$pass" RCON_PORT_NEW="$port" "$NODE_BIN" -e '
        const fs = require("fs"); const p = require(process.argv[2] + "/lib/properties.js");
        const file = process.argv[1];
        const doc = p.set(p.parse(fs.readFileSync(file, "utf8")), {
          "enable-rcon": "true", "rcon.port": process.env.RCON_PORT_NEW, "rcon.password": process.env.RCON_PASSWORD_NEW });
        fs.writeFileSync(file, p.stringify(doc));' "$props" "$SRC"
    fi
    changed "turned on RCON in server.properties (backup: server.properties.before-rconsole)"
    RESTART_MC=1
  else info "RCON is on (port ${port:-25575})"; fi
  [ -n "$port" ] || port=25575
  fi

  # --- configuration -------------------------------------------------------------
  step "Configuration ($ENV_FILE)"
  setenv() { # key value: add when missing, never overwrite the admin's values
    if [ -f "$ENV_FILE" ] && grep -qE "^$1=" "$ENV_FILE"; then return; fi
    if [ "$DRY" = 1 ]; then info "[dry-run] $1=$( [ "$1" = RCON_PASSWORD ] && echo '••••' || echo "$2")"; else printf '%s=%s\n' "$1" "$2" >> "$ENV_FILE"; fi
    [ "$1" = RCON_PASSWORD ] && changed "$1 set" || changed "$1=$2"
  }
  if [ ! -f "$ENV_FILE" ] && [ "$DRY" = 0 ]; then
    install -m 0600 /dev/null "$ENV_FILE"
    printf '# rconsole configuration, written by install.sh. See README "Configuration".\n' > "$ENV_FILE"
  fi
  if [ "$NEW" = 0 ]; then
    setenv RCON_PASSWORD "$pass"
    setenv RCON_PORT "$port"
  fi
  setenv WEB_HOST "$WEB_HOST"
  setenv WEB_PORT "$WEB_PORT"
  setenv MC_DIR "$MC_DIR"
  setenv BACKUP_DIR "$BACKUP_DIR"
  setenv SERVERS_DIR "$SERVERS_DIR"
  setenv MC_SERVICE "$MC_SERVICE"
  setenv MC_JAR "$MC_JAR"
  setenv MC_USER "$MC_USER"
  setenv MC_GROUP "$MC_GROUP"
  setenv NODE_BIN "$NODE_BIN"
  setenv RCONSOLE_DIR "$DIR"
  [ "$DRY" = 1 ] || chmod 600 "$ENV_FILE"

  # --- services and polkit ---------------------------------------------------------
  step "Services"
  load_rconsole_env "$ENV_FILE"
  export MC_DIR BACKUP_DIR SERVERS_DIR MC_SERVICE MC_USER MC_GROUP NODE_BIN RCONSOLE_DIR="$DIR"
  local src dest tmp; tmp="$(mktemp)"
  for src in rconsole.service rconsole-job@.service rconsole-net@.service rconsole-selfupdate.service rconsole-limits.service rconsole-mc@.service rconsole-mc@.socket 50-rconsole.rules; do
    if [ "$src" = 50-rconsole.rules ]; then dest="$POLKIT_DIR/$src"; else dest="$UNIT_DIR/$src"; fi
    render_unit < "$SRC/$src" > "$tmp" || die "could not render $src"
    if [ -f "$dest" ] && cmp -s "$tmp" "$dest"; then continue; fi
    run install -D -m 0644 "$tmp" "$dest"
    changed "installed $dest"
  done
  rm -f "$tmp"
  run systemctl daemon-reload
  # Per-server memory limits and the RCON firewall, restored at boot.
  if ! systemctl is-enabled --quiet rconsole-limits.service 2>/dev/null; then
    run systemctl enable rconsole-limits.service
    changed "enabled rconsole-limits.service (server memory limits, RCON firewall)"
  fi

  # --- hardening ------------------------------------------------------------------------
  step "Hardening"
  # RCON speaks plain text and only rconsole on this machine needs it.
  if grep -qE '^RCON_FIREWALL=' "$ENV_FILE" 2>/dev/null; then info "RCON firewall: $(grep -E '^RCON_FIREWALL=' "$ENV_FILE" | cut -d= -f2-) (set in $ENV_FILE)"
  elif confirm "Close the RCON ports to other machines (nftables rule; rconsole uses RCON locally)?" y; then info "RCON is closed to other machines (RCON_FIREWALL=off in $ENV_FILE turns it off)"
  else setenv RCON_FIREWALL off; fi
  # With ptrace_scope 0, any process of the Minecraft user (a plugin) may read
  # the memory of the others; 1 limits that to a process's own children.
  local yama=/proc/sys/kernel/yama/ptrace_scope sysctl_file=/etc/sysctl.d/60-rconsole-ptrace.conf
  if [ -r "$yama" ] && [ "$(cat "$yama")" = 0 ] && [ ! -f "$sysctl_file" ]; then
    if confirm "Stop processes of one user from reading each other's memory (kernel.yama.ptrace_scope=1; debuggers then need sudo)?" y; then
      if [ "$DRY" = 1 ]; then info "[dry-run] write $sysctl_file"
      else printf '# Written by the rconsole installer: a plugin may not read other processes of its user.\nkernel.yama.ptrace_scope = 1\n' > "$sysctl_file"; sysctl -q -p "$sysctl_file" || true; fi
      changed "set kernel.yama.ptrace_scope=1 ($sysctl_file)"
    fi
  fi
  run systemctl start rconsole-limits.service || warn "rconsole-limits.service failed (journalctl -u rconsole-limits); servers run without memory limits"
  if systemctl is-active --quiet rconsole.service 2>/dev/null; then
    run systemctl restart rconsole.service; info "restarted rconsole"
  else
    run systemctl enable --now rconsole.service; changed "started rconsole"
  fi

  # --- first account --------------------------------------------------------------
  step "Your account"
  local users=0
  [ -f /var/lib/rconsole/users.json ] && users="$("$NODE_BIN" -p 'Object.keys(JSON.parse(require("fs").readFileSync("/var/lib/rconsole/users.json","utf8"))).length' 2>/dev/null || echo 0)"
  if [ "$users" -gt 0 ]; then info "accounts exist; manage them with: sudo -u rconsole node $DIR/cli.js user list"
  else
    [ -n "$ADMIN" ] || ADMIN="$(ask "Name for your rconsole account" admin)"
    [[ "$ADMIN" =~ ^[A-Za-z0-9._-]{2,32}$ ]] || die "account names are 2-32 letters, digits, . _ -"
    if [ "$DRY" = 1 ]; then info "[dry-run] create account $ADMIN"
    elif [ "$YES" = 0 ] && [ -r /dev/tty ]; then
      (cd "$DIR" && STATE_DIRECTORY=/var/lib/rconsole setpriv --reuid=rconsole --regid=rconsole --init-groups "$NODE_BIN" cli.js user add "$ADMIN" < /dev/tty)
      changed "created account $ADMIN"
    else
      local pw; pw="$(head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 20)"
      (cd "$DIR" && printf '%s\n%s\n' "$pw" "$pw" | STATE_DIRECTORY=/var/lib/rconsole setpriv --reuid=rconsole --regid=rconsole --init-groups "$NODE_BIN" cli.js user add "$ADMIN" >/dev/null)
      changed "created account $ADMIN with password $pw (change it: sudo -u rconsole node $DIR/cli.js user passwd $ADMIN)"
    fi
  fi

  # --- Minecraft restart for RCON ---------------------------------------------------
  if [ "$RESTART_MC" = 1 ]; then
    step "Restart Minecraft"
    if confirm "RCON takes effect after a Minecraft restart. Restart $MC_SERVICE now? Players are disconnected" n; then
      run systemctl restart "$MC_SERVICE"; changed "restarted $MC_SERVICE"
    else warn "Restart $MC_SERVICE when convenient (rconsole's Console shows 'RCON offline' until then)."; fi
  fi

  # --- summary ------------------------------------------------------------------------
  step "Done"
  local ips; ips="$(hostname -I 2>/dev/null | awk '{print $1}')"
  if [ "$WEB_HOST" = 0.0.0.0 ]; then info "Open ${B}http://${ips:-<this-server>}:$WEB_PORT${N}"; else info "Open ${B}http://$WEB_HOST:$WEB_PORT${N}"; fi
  [ "$NEW" = 0 ] || info "Create your first server under ${B}Server → Servers${N}: pick the software and version, rconsole does the rest."
  info "rconsole speaks plain HTTP: keep it on your LAN/VPN, or put a TLS reverse proxy in front (README: Traefik) and set TRUST_PROXY."
  [ "${#CHANGES[@]}" -gt 0 ] || info "Nothing needed changing."
  for n in "${NOTES[@]+"${NOTES[@]}"}"; do printf '    %s!%s %s\n' "$Y" "$N" "$n"; done
  info "Uninstall: sudo $DIR/install.sh --uninstall"
}

main "$@"
exit
