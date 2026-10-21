#!/bin/bash
# Updates rconsole from its git remote. Run by rconsole-selfupdate.service
# (as root), which rconsole may start through polkit. It only ever
# fast-forwards the checkout to the configured branch of its own remote;
# rconsole can't pass arguments to it.
#
#   1. fetch and fast-forward (refuses local changes or diverged history);
#      with SELF_UPDATE_SIGNERS in /etc/rconsole.env, only to the newest
#      release tag signed by one of those SSH keys
#   2. install the Node.js the new version needs (package.json engines)
#      from NodeSource when the system's is older, otherwise roll back;
#      also when the code is already up to date
#   3. check the new code parses, otherwise roll back
#   4. install changed unit files / polkit rule, unless the installed copy
#      was customized (then it reports the manual step instead)
#   5. restart rconsole; if it doesn't come up, roll back and restart again
#
# Progress and the result go to /var/lib/rconsole-selfupdate/self-update.json
# (root-owned, world-readable) for the UI.
#
# Everything is inside main() so bash has parsed the whole script before git
# replaces this file on disk.

main() {
  set -euo pipefail
  local dir="${RCONSOLE_DIR:-/opt/rconsole}"
  local branch="${RCONSOLE_BRANCH:-main}"
  # Status goes to a root-owned directory of its own, never into rconsole's
  # state dir: rconsole could plant a symlink there and have root write to
  # (and hand over) any file. STATE_DIR is deliberately ignored.
  local status_dir="${STATUS_DIR:-/var/lib/rconsole-selfupdate}"
  local status="$status_dir/self-update.json"
  local service="${RCONSOLE_SERVICE:-rconsole.service}"
  local unit_dir="${SYSTEMD_DIR:-/etc/systemd/system}" polkit_dir="${POLKIT_DIR:-/etc/polkit-1/rules.d}"
  local git=(git -C "$dir" -c safe.directory="$dir")
  local before after manual=() installed=() note="" node_error="" node_changed=0 node_need=""

  # For the UI's progress: the step running now, when each one started
  # and the ones still to come (plan), as keys it has labels for.
  local step="" steps_json="" started="" plan="fetch check files restart"
  report() { # state message [step]
    local manual_json="" installed_json="" plan_json="" m tmp now
    now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    started="${started:-$now}"
    if [ -n "${3:-}" ] && [ "$3" != "$step" ]; then
      step="$3"
      steps_json+="${steps_json:+,}{\"step\":\"$step\",\"at\":\"$now\"}"
    fi
    for m in "${manual[@]+"${manual[@]}"}"; do manual_json+="${manual_json:+,}\"$m\""; done
    for m in "${installed[@]+"${installed[@]}"}"; do installed_json+="${installed_json:+,}\"$m\""; done
    for m in $plan; do plan_json+="${plan_json:+,}\"$m\""; done
    tmp="$(mktemp "$status_dir/.status.XXXXXX")" # O_EXCL, random name
    printf '{"state":"%s","message":"%s","from":"%s","to":"%s","at":"%s","started":"%s","step":"%s","steps":[%s],"plan":[%s],"node":"%s","manual":[%s],"installed":[%s]}\n' \
      "$1" "${2//\"/\'}" "${before:-}" "${after:-}" "$now" "$started" "$step" "$steps_json" "$plan_json" "${node_need:-}" "$manual_json" "$installed_json" > "$tmp"
    chmod 0644 "$tmp" # no secrets; rconsole only reads it
    mv -fT "$tmp" "$status"
    echo "self-update: $1: $2"
  }

  # The Node.js the checked-out version needs (engines.node in its
  # package.json): installed from NodeSource (bin/node.sh) when the one
  # rconsole runs with is older. Sets node_error when it can't.
  ensure_node() {
    local need have bin out
    # Versions before 4.7 have no bin/node.sh and run on any supported node.
    [ -f "$dir/bin/node.sh" ] || return 0
    # shellcheck source=node.sh
    source "$dir/bin/node.sh"
    bin="${NODE_BIN:-$NODESOURCE_BIN}"
    need="$(node_required "$dir")"
    have="$(node_major "$bin")"
    [ "$have" -ge "$need" ] && return 0
    if [ "$bin" != "$NODESOURCE_BIN" ]; then
      node_error="rconsole needs Node.js $need but $bin is v$have; install a newer one there (NODE_BIN in /etc/rconsole.env)"
      return 1
    fi
    node_need="$need"
    [[ " $plan " == *" node "* ]] || plan="${plan/fetch/fetch node}"
    report running "Installing Node.js $need (this system has v$have)" node
    if ! out="$(install_nodesource "$need" 2>&1)"; then
      node_error="rconsole needs Node.js $need; installing it from NodeSource failed: $(tail -n 1 <<<"$out")"
      return 1
    fi
    installed+=("Node.js $("$NODESOURCE_BIN" -v) from NodeSource")
    node_changed=1
  }

  mkdir -p -m 0755 "$status_dir"
  if [ -L "$status_dir" ] || [ "$(stat -c %u "$status_dir")" != "$(id -u)" ]; then
    echo "self-update: $status_dir must be a directory owned by $(id -un)" >&2
    exit 1
  fi

  # The installed (trusted) version's reader, for SELF_UPDATE_SIGNERS.
  # shellcheck source=units.sh
  source "$dir/bin/units.sh"
  load_rconsole_env "${RCONSOLE_ENV:-/etc/rconsole.env}"
  local signers="${SELF_UPDATE_SIGNERS:-}" target=FETCH_HEAD what="origin/$branch"

  before="$("${git[@]}" rev-parse HEAD)"
  report running "Fetching $branch" fetch
  if ! "${git[@]}" fetch --quiet origin "$branch"; then
    report failed "git fetch failed (network?)"
    exit 1
  fi
  if [ -n "$("${git[@]}" status --porcelain --untracked-files=no)" ]; then
    report failed "$dir has local changes; update it by hand"
    exit 1
  fi
  if [ -n "$signers" ]; then
    # Signed releases only: the newest v* tag with an SSH signature from a
    # key in the allowed-signers file. That file is root's, so neither
    # rconsole nor whoever can push to GitHub can add a key to it.
    if [[ ! "$signers" =~ ^/[A-Za-z0-9._/-]+$ ]] || [ ! -f "$signers" ] || [ -L "$signers" ] \
      || [ "$(stat -c %u "$signers")" != 0 ] || [ -n "$(find "$signers" -perm /022)" ]; then
      report failed "SELF_UPDATE_SIGNERS must be a file owned by root and writable only by root"
      exit 1
    fi
    if ! "${git[@]}" fetch --quiet --force origin 'refs/tags/v*:refs/tags/v*'; then
      report failed "git fetch of the release tags failed (network?)"
      exit 1
    fi
    target=""
    local t
    while read -r t; do
      "${git[@]}" cat-file tag "$t" 2>/dev/null | grep -q -- '-----BEGIN SSH SIGNATURE-----' || continue
      if "${git[@]}" -c gpg.ssh.program=ssh-keygen -c gpg.ssh.allowedSignersFile="$signers" verify-tag "$t" >/dev/null 2>&1; then
        target="$t^{commit}" what="$t"
        break
      fi
    done < <("${git[@]}" tag -l 'v*' --sort=-v:refname)
    if [ -z "$target" ]; then
      report failed "No release tag signed by a key in $signers"
      exit 1
    fi
    if "${git[@]}" merge-base --is-ancestor "$target" HEAD; then
      target=HEAD note=" ($what)"
    fi
  fi
  if ! "${git[@]}" merge --ff-only --quiet "$target"; then
    report failed "Local history differs from $what; update it by hand"
    exit 1
  fi
  after="$("${git[@]}" rev-parse HEAD)"

  # Up to date: only the Node.js it needs may be missing (the update to
  # 4.7 ran with the old script, which didn't install it).
  if [ "$before" = "$after" ]; then
    plan="fetch restart"
    if ! ensure_node; then
      report failed "$node_error"
      exit 1
    fi
    if [ "$node_changed" = 0 ]; then
      report done "Already up to date$note"
      exit 0
    fi
    report running "Restarting rconsole" restart
    systemctl restart "$service" || true
    sleep 6
    if ! systemctl is-active --quiet "$service"; then
      report failed "rconsole didn't start on Node.js $("$NODESOURCE_BIN" -v) (see journalctl -u $service)"
      exit 1
    fi
    report done "Installed Node.js $("$NODESOURCE_BIN" -v); rconsole is up to date$note" done
    exit 0
  fi

  if ! ensure_node; then
    "${git[@]}" reset --quiet --hard "$before"
    report failed "$node_error; stayed on the old version"
    exit 1
  fi

  report running "Checking the new version" check
  local f
  for f in "$dir"/server.js "$dir"/cli.js "$dir"/lib/*.js "$dir"/bin/*.js; do
    if ! node --check "$f" 2>/dev/null; then
      "${git[@]}" reset --quiet --hard "$before"
      report failed "${f#"$dir"/} doesn't parse; stayed on the old version"
      exit 1
    fi
  done

  # Unit files and the polkit rule, rendered with this host's paths and users
  # (bin/units.sh, values from /etc/rconsole.env): bring the installed copy
  # up to date when it is exactly some version this repository shipped (so
  # it wasn't customized), even if that change came in an earlier update
  # that ran by hand. Customized copies are left alone and reported when
  # they change.
  report running "Updating system files" files
  # shellcheck source=units.sh
  source "$dir/bin/units.sh"
  load_rconsole_env "${RCONSOLE_ENV:-/etc/rconsole.env}"
  # Servers rconsole installs itself (4.0): their folder, owned by the
  # Minecraft user, readable for rconsole through the group.
  local sv="${SERVERS_DIR:-/srv/minecraft-servers}"
  if [ ! -d "$sv" ] && id "${MC_USER:-minecraft}" >/dev/null 2>&1; then
    install -d -o "${MC_USER:-minecraft}" -g "${MC_GROUP:-minecraft}" -m 2750 "$sv" && installed+=("$sv")
  fi
  local changed=0 src dest shipped c rendered
  rendered="$(mktemp)"
  for src in rconsole.service rconsole-job@.service rconsole-net@.service rconsole-try@.service rconsole-selfupdate.service rconsole-limits.service rconsole-mc@.service rconsole-mc@.socket 50-rconsole.rules; do
    [ -f "$dir/$src" ] || continue
    if [ "$src" = 50-rconsole.rules ]; then dest="$polkit_dir/$src"; else dest="$unit_dir/$src"; fi
    render_unit < "$dir/$src" > "$rendered" || continue
    [ -f "$dest" ] && cmp -s "$dest" "$rendered" && continue
    shipped=0
    if [ -f "$dest" ]; then
      while read -r c; do
        if "${git[@]}" show "$c:$src" 2>/dev/null | render_unit | cmp -s - "$dest"; then shipped=1; break; fi
      done < <("${git[@]}" log --format='%H' -- "$src")
    fi
    if [ ! -f "$dest" ] || [ "$shipped" = 1 ]; then
      install -m 0644 "$rendered" "$dest"
      installed+=("$src")
      [ "$src" != 50-rconsole.rules ] && changed=1
    elif ! "${git[@]}" diff --quiet "$before" "$after" -- "$src"; then
      manual+=("$src changed but your installed copy is customized: merge $dir/$src into $dest")
    fi
  done
  rm -f "$rendered"
  [ "$changed" = 1 ] && systemctl daemon-reload
  # 4.3: memory limits and the RCON firewall, kept at boot.
  if [ -f "$unit_dir/rconsole-limits.service" ] && ! systemctl is-enabled --quiet rconsole-limits.service 2>/dev/null; then
    systemctl enable rconsole-limits.service >/dev/null 2>&1 && installed+=("enabled rconsole-limits.service")
    command -v nft >/dev/null || manual+=("apt install nftables zstd: closes RCON to other machines and speeds up backups")
  fi
  systemctl start rconsole-limits.service || manual+=("rconsole-limits.service failed: journalctl -u rconsole-limits")

  report running "Restarting rconsole" restart
  systemctl restart "$service" || true
  sleep 6
  if ! systemctl is-active --quiet "$service"; then
    "${git[@]}" reset --quiet --hard "$before"
    systemctl restart "$service" || true
    report failed "The new version didn't start (see journalctl -u $service); rolled back"
    exit 1
  fi
  report done "Updated $(printf %.7s "$before") → $(printf %.7s "$after")" done
}

main "$@"
exit
