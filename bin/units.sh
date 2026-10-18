# shellcheck shell=bash
# Shared by install.sh and self-update.sh: the unit files and polkit rule in
# this repository are written for the defaults (/srv/minecraft, user
# minecraft, minecraft.service, /opt/rconsole). render_unit prints one of
# them with this host's values from /etc/rconsole.env substituted, so an
# installed copy can be compared with what this repository ships.

# load_rconsole_env [file]: reads the keys render_unit needs, without
# executing the file.
load_rconsole_env() {
  local file="${1:-/etc/rconsole.env}" key value
  [ -r "$file" ] || return 0
  while IFS='=' read -r key value; do
    case "$key" in
      MC_DIR|BACKUP_DIR|SERVERS_DIR|MC_USER|MC_GROUP|MC_SERVICE|RCONSOLE_DIR|NODE_BIN|SELF_UPDATE_SIGNERS)
        value="${value%\"}"; value="${value#\"}"
        printf -v "$key" '%s' "$value"
        export "${key?}"
        ;;
    esac
  done < <(grep -E '^[A-Z_]+=' "$file")
}

# render_unit < template > rendered
render_unit() {
  local mc="${MC_DIR:-/srv/minecraft}" bk="${BACKUP_DIR:-/srv/minecraft-backups}" sv="${SERVERS_DIR:-/srv/minecraft-servers}"
  local user="${MC_USER:-minecraft}" group="${MC_GROUP:-minecraft}" svc="${MC_SERVICE:-minecraft.service}" dir="${RCONSOLE_DIR:-/opt/rconsole}"
  local node="${NODE_BIN:-/usr/bin/node}" v
  for v in "$mc" "$bk" "$sv" "$user" "$group" "$svc" "$dir" "$node"; do
    [[ "$v" =~ ^[A-Za-z0-9._/@-]+$ ]] || { echo "units: unsafe value: $v" >&2; return 1; }
  done
  sed -e "s#/srv/minecraft-backups#@BK@#g" \
      -e "s#/srv/minecraft-servers#@SV@#g" \
      -e "s#/srv/minecraft#${mc}#g" \
      -e "s#@BK@#${bk}#g" \
      -e "s#@SV@#${sv}#g" \
      -e "s#/opt/rconsole#${dir}#g" \
      -e "s#^User=minecraft\$#User=${user}#" \
      -e "s#^Group=minecraft\$#Group=${group}#" \
      -e "s#^SupplementaryGroups=minecraft\$#SupplementaryGroups=${group}#" \
      -e "s#^SocketUser=minecraft\$#SocketUser=${user}#" \
      -e "s#minecraft\\.service#${svc}#g" \
      -e "s#/usr/bin/node #${node} #g"
}
