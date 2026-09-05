#!/usr/bin/env bash
# Install ClipSpan on Debian/Ubuntu (amd64).
# Testers (use www — curl drops basic auth across the apex→www redirect):
#   curl -fsSL -u "clipspan:PASSWORD" https://www.clipspan.com/apt/install.sh | sudo bash
# Adds the ClipSpan APT repo. dists/, pool/, and the signing key must be
# publicly readable. This script does not download from GitHub Releases
# (the repo is private).
set -euo pipefail

CLIPSPAN_APT_BASE="${CLIPSPAN_APT_BASE:-https://www.clipspan.com/apt}"
KEYRING_PATH="/usr/share/keyrings/clipspan-archive-keyring.gpg"
LIST_PATH="/etc/apt/sources.list.d/clipspan.list"
PKG="clipspan"

normalize_apt_base() {
  local base="${1%/}"
  case "$base" in
    https://clipspan.com/apt|http://clipspan.com/apt)
      printf '%s\n' "https://www.clipspan.com/apt"
      ;;
    *)
      printf '%s\n' "$base"
      ;;
  esac
}

CLIPSPAN_APT_BASE="$(normalize_apt_base "$CLIPSPAN_APT_BASE")"

if [[ "$(id -u)" -eq 0 ]]; then
  SUDO=""
else
  SUDO="sudo"
fi

need() {
  command -v "$1" >/dev/null || {
    echo "error: need $1" >&2
    exit 1
  }
}

need curl
need apt-get

arch="$(dpkg --print-architecture 2>/dev/null || true)"
if [[ "$arch" != "amd64" ]]; then
  echo "error: ClipSpan .deb is amd64 only (this machine is ${arch:-unknown})" >&2
  exit 1
fi

# Do not follow redirects: a 301 to www would drop later apt credentials, and
# GitHub/Cloudflare 301/401/404 must surface as a failed probe.
http_status() {
  local url="$1"
  curl -sS -o /dev/null -w '%{http_code}' --max-redirs 0 "$url" || true
}

install_from_repo() {
  need gpg
  echo "Installing from $CLIPSPAN_APT_BASE"
  tmp="$(mktemp)"
  curl -fsS --max-redirs 0 "$CLIPSPAN_APT_BASE/clipspan.asc" -o "$tmp"
  $SUDO mkdir -p /usr/share/keyrings
  $SUDO gpg --batch --yes --dearmor -o "$KEYRING_PATH" "$tmp"
  rm -f "$tmp"
  echo "deb [arch=amd64 signed-by=$KEYRING_PATH] $CLIPSPAN_APT_BASE stable main" \
    | $SUDO tee "$LIST_PATH" >/dev/null
  $SUDO apt-get update
  $SUDO apt-get install -y "$PKG"
}

inrelease_url="$CLIPSPAN_APT_BASE/dists/stable/InRelease"
code="$(http_status "$inrelease_url")"
if [[ "$code" == "200" ]]; then
  install_from_repo
else
  echo "error: APT metadata at $inrelease_url returned HTTP ${code:-failed}." >&2
  echo "GitHub Releases are not public (private repo). Use https://www.clipspan.com/apt" >&2
  echo "(not the apex clipspan.com host — curl drops basic auth on that redirect)." >&2
  echo "dists/, pool/, and clipspan.asc must be readable without basic auth." >&2
  exit 1
fi

echo
echo "ClipSpan installed. Launch it from the app menu."
echo "Uninstall: sudo apt remove $PKG"
echo "Remove the repo: sudo rm -f $LIST_PATH $KEYRING_PATH && sudo apt update"
