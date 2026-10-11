#!/bin/bash
# Updates rconsole from its git remote. Run by rconsole-selfupdate.service
# (as root), which rconsole may start through polkit. It only ever
# fast-forwards the checkout to the configured branch of its own remote;
# rconsole can't pass arguments to it.
#
#   1. fetch and fast-forward (refuses local changes or diverged history)
#   2. check the new code parses, otherwise roll back
#   3. install changed unit files / polkit rule, unless the installed copy
#      was customized (then it reports the manual step instead)
#   4. restart rconsole; if it doesn't come up, roll back and restart again
#
# Progress and the result go to $STATE_DIR/self-update.json for the UI.
#
# Everything is inside main() so bash has parsed the whole script before git
# replaces this file on disk.

main() {
  set -euo pipefail
  local dir="${RCONSOLE_DIR:-/opt/rconsole}"
  local branch="${RCONSOLE_BRANCH:-main}"
  local state_dir="${STATE_DIR:-/var/lib/rconsole}"
  local status="$state_dir/self-update.json"
  local service="${RCONSOLE_SERVICE:-rconsole.service}"
  local unit_dir="${SYSTEMD_DIR:-/etc/systemd/system}" polkit_dir="${POLKIT_DIR:-/etc/polkit-1/rules.d}"
  local git=(git -C "$dir" -c safe.directory="$dir")
  local before after manual=() installed=()

  report() { # state message
    local manual_json="" installed_json="" m
    for m in "${manual[@]+"${manual[@]}"}"; do manual_json+="${manual_json:+,}\"$m\""; done
    for m in "${installed[@]+"${installed[@]}"}"; do installed_json+="${installed_json:+,}\"$m\""; done
    printf '{"state":"%s","message":"%s","from":"%s","to":"%s","at":"%s","manual":[%s],"installed":[%s]}\n' \
      "$1" "${2//\"/\'}" "${before:-}" "${after:-}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$manual_json" "$installed_json" > "$status.tmp"
    chown --reference="$state_dir" "$status.tmp" 2>/dev/null || true
    chmod 0600 "$status.tmp"
    mv "$status.tmp" "$status"
    echo "self-update: $1: $2"
  }

  before="$("${git[@]}" rev-parse HEAD)"
  report running "Fetching $branch"
  if ! "${git[@]}" fetch --quiet origin "$branch"; then
    report failed "git fetch failed (network?)"
    exit 1
  fi
  if [ -n "$("${git[@]}" status --porcelain --untracked-files=no)" ]; then
    report failed "$dir has local changes; update it by hand"
    exit 1
  fi
  if ! "${git[@]}" merge --ff-only --quiet FETCH_HEAD; then
    report failed "Local history differs from origin/$branch; update it by hand"
    exit 1
  fi
  after="$("${git[@]}" rev-parse HEAD)"
  if [ "$before" = "$after" ]; then
    report done "Already up to date"
    exit 0
  fi

  report running "Checking the new version"
  local f
  for f in "$dir"/server.js "$dir"/cli.js "$dir"/lib/*.js "$dir"/bin/*.js; do
    if ! node --check "$f" 2>/dev/null; then
      "${git[@]}" reset --quiet --hard "$before"
      report failed "${f#"$dir"/} doesn't parse; stayed on the old version"
      exit 1
    fi
  done

  # Unit files and the polkit rule: install the new copy only when the
  # installed one is exactly what the old version shipped.
  local changed=0 src dest
  for src in rconsole.service rconsole-job@.service rconsole-net@.service rconsole-selfupdate.service 50-rconsole.rules; do
    [ -f "$dir/$src" ] || continue
    if [ "$src" = 50-rconsole.rules ]; then dest="$polkit_dir/$src"; else dest="$unit_dir/$src"; fi
    "${git[@]}" diff --quiet "$before" "$after" -- "$src" && continue
    if [ ! -f "$dest" ] || cmp -s "$dest" <("${git[@]}" show "$before:$src" 2>/dev/null); then
      install -m 0644 "$dir/$src" "$dest"
      installed+=("$src")
      [ "$src" != 50-rconsole.rules ] && changed=1
    else
      manual+=("$src changed but your installed copy is customized: merge $dir/$src into $dest")
    fi
  done
  [ "$changed" = 1 ] && systemctl daemon-reload

  report running "Restarting rconsole"
  systemctl restart "$service" || true
  sleep 6
  if ! systemctl is-active --quiet "$service"; then
    "${git[@]}" reset --quiet --hard "$before"
    systemctl restart "$service" || true
    report failed "The new version didn't start (see journalctl -u $service); rolled back"
    exit 1
  fi
  report done "Updated $(printf %.7s "$before") → $(printf %.7s "$after")"
}

main "$@"
exit
