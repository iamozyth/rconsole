# shellcheck shell=bash
# Shared by install.sh and self-update.sh: which Node.js rconsole needs and,
# on Debian/Ubuntu, installing it from NodeSource when the system's own
# package is too old (Debian 12 ships 18, Debian 13 ships 20).

# Where NodeSource's package puts node.
NODESOURCE_BIN=/usr/bin/node

# node_required [dir]: the major version from package.json's engines.node
# (">=24" → 24). Read without running node, which may be the old one.
node_required() {
  local v
  v="$(grep -oE '"node"[[:space:]]*:[[:space:]]*">=[[:space:]]*[0-9]+' "${1:-.}/package.json" 2>/dev/null | grep -oE '[0-9]+$' || true)"
  echo "${v:-24}"
}

# node_major [binary]: the major version of that node, 0 if it doesn't run.
node_major() {
  local bin="${1:-node}" v
  v="$("$bin" -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)"
  [[ "$v" =~ ^[0-9]+$ ]] && echo "$v" || echo 0
}

# install_nodesource major: as root, adds NodeSource's apt repository for
# that major (key in /etc/apt/keyrings, pinned above the distribution's own
# nodejs) and installs nodejs from it, replacing Debian's package. Prints
# what went wrong and returns 1 when it can't.
install_nodesource() {
  local major="$1" key=/etc/apt/keyrings/nodesource.asc list=/etc/apt/sources.list.d/nodesource.list pin=/etc/apt/preferences.d/nodesource-nodejs
  [[ "$major" =~ ^[0-9]+$ ]] || { echo "node: bad major version: $major" >&2; return 1; }
  command -v apt-get >/dev/null || { echo "node: no apt-get here; install Node.js $major or newer by hand" >&2; return 1; }
  export DEBIAN_FRONTEND=noninteractive
  if ! command -v curl >/dev/null || [ ! -d /etc/ssl/certs ]; then
    apt-get update -qq && apt-get install -y -qq curl ca-certificates >/dev/null || { echo "node: couldn't install curl" >&2; return 1; }
  fi
  install -d -m 0755 /etc/apt/keyrings
  # apt reads an ASCII-armored key from a .asc file directly (no gpg needed).
  curl -fsSL --retry 3 -o "$key.tmp" https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    && grep -q -- '-----BEGIN PGP PUBLIC KEY BLOCK-----' "$key.tmp" \
    || { rm -f "$key.tmp"; echo "node: couldn't download NodeSource's signing key (network?)" >&2; return 1; }
  chmod 0644 "$key.tmp" && mv -f "$key.tmp" "$key"
  echo "deb [signed-by=$key] https://deb.nodesource.com/node_${major}.x nodistro main" > "$list"
  printf 'Package: nodejs\nPin: origin deb.nodesource.com\nPin-Priority: 600\n' > "$pin"
  chmod 0644 "$list" "$pin"
  apt-get update -qq || { echo "node: apt-get update failed" >&2; return 1; }
  apt-get install -y -qq nodejs >/dev/null || { echo "node: apt-get install nodejs failed" >&2; return 1; }
  local got; got="$(node_major "$NODESOURCE_BIN")"
  [ "$got" -ge "$major" ] || { echo "node: $NODESOURCE_BIN is still v$got after the install" >&2; return 1; }
}
