#!/usr/bin/env bash
# Install ClipSpan on Debian/Ubuntu (amd64).
# Testers:
#   curl -fsSL -u "clipspan:YOUR_PASSWORD" https://clipspan.com/apt/install.sh | sudo bash
set -euo pipefail

CLIPSPAN_APT_BASE="${CLIPSPAN_APT_BASE:-https://clipspan.com/apt}"
CLIPSPAN_APT_USER="${CLIPSPAN_APT_USER:-clipspan}"
KEYRING_PATH="/usr/share/keyrings/clipspan-archive-keyring.gpg"
LIST_PATH="/etc/apt/sources.list.d/clipspan.list"
AUTH_PATH="/etc/apt/auth.conf.d/clipspan.conf"
PKG="clipspan"

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
need gpg

arch="$(dpkg --print-architecture 2>/dev/null || true)"
if [[ "$arch" != "amd64" ]]; then
  echo "error: ClipSpan .deb is amd64 only (this machine is ${arch:-unknown})" >&2
  exit 1
fi

prompt_password() {
  if [[ -n "${CLIPSPAN_APT_PASSWORD:-}" ]]; then
    return 0
  fi
  if [[ ! -r /dev/tty ]]; then
    echo "error: set CLIPSPAN_APT_PASSWORD to the tester password" >&2
    exit 1
  fi
  printf "ClipSpan tester password: " >/dev/tty
  IFS= read -r CLIPSPAN_APT_PASSWORD </dev/tty
  printf "\n" >/dev/tty
  if [[ -z "$CLIPSPAN_APT_PASSWORD" ]]; then
    echo "error: password is empty" >&2
    exit 1
  fi
}

host_from_base() {
  local rest="${CLIPSPAN_APT_BASE#https://}"
  rest="${rest#http://}"
  printf "%s" "${rest%%/*}"
}

curl_auth() {
  curl -fsSL --user "${CLIPSPAN_APT_USER}:${CLIPSPAN_APT_PASSWORD}" "$@"
}

http_code() {
  local url="$1"
  curl -sS -o /dev/null -w "%{http_code}" --user "${CLIPSPAN_APT_USER}:${CLIPSPAN_APT_PASSWORD}" "$url" || true
}

write_auth_conf() {
  local host="$1"
  local escaped="${CLIPSPAN_APT_PASSWORD//\\/\\\\}"
  escaped="${escaped//\"/\\\"}"
  local tmp
  tmp="$(mktemp)"
  chmod 600 "$tmp"
  printf 'machine %s\nlogin %s\npassword "%s"\n' "$host" "$CLIPSPAN_APT_USER" "$escaped" >"$tmp"
  $SUDO mkdir -p /etc/apt/auth.conf.d
  $SUDO install -m 600 "$tmp" "$AUTH_PATH"
  rm -f "$tmp"
}

prompt_password

echo "Installing from $CLIPSPAN_APT_BASE"
code="$(http_code "$CLIPSPAN_APT_BASE/dists/stable/InRelease")"
if [[ "$code" == "401" || "$code" == "403" ]]; then
  echo "error: tester password was not accepted" >&2
  exit 1
fi
if [[ "$code" != "200" ]]; then
  echo "error: APT repo is not available (${code:-no response})" >&2
  exit 1
fi

tmp="$(mktemp)"
curl_auth "$CLIPSPAN_APT_BASE/clipspan.asc" -o "$tmp"
$SUDO mkdir -p /usr/share/keyrings
$SUDO gpg --batch --yes --dearmor -o "$KEYRING_PATH" "$tmp"
rm -f "$tmp"

write_auth_conf "$(host_from_base)"
echo "deb [arch=amd64 signed-by=$KEYRING_PATH] $CLIPSPAN_APT_BASE stable main" \
  | $SUDO tee "$LIST_PATH" >/dev/null

$SUDO apt-get update
$SUDO apt-get install -y "$PKG"

echo
echo "ClipSpan installed. Launch it from the app menu."
echo "Uninstall: sudo apt remove $PKG"
echo "Remove the repo: sudo rm -f $LIST_PATH $KEYRING_PATH $AUTH_PATH && sudo apt update"
