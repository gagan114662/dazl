# shellcheck shell=bash
# Sourced by install-prod.sh (#1089). ensure_ledger_append_only LEDGER: make the deletion ledger append-only with the
# kernel attribute (chattr +a, which only root can set or clear) and PROVE it by reading the flag back with lsattr.
# Returns 0 only when the 'a' flag is read back on the file; otherwise prints why on stderr and returns 1, so the
# caller can fail closed. The app user keeps ownership and appends (lib/tenant/ledger.ts opens it with 'a').
_ledger_flags() { local out; out=$(lsattr -d -- "$1" 2>/dev/null) || return 1; [ -n "$out" ] || return 1; printf '%s\n' "${out%% *}"; }
ensure_ledger_append_only() {
  local f=$1 flags
  command -v chattr >/dev/null 2>&1 || { echo "install-prod: chattr not found: cannot make the deletion ledger $f append-only (install e2fsprogs)" >&2; return 1; }
  command -v lsattr >/dev/null 2>&1 || { echo "install-prod: lsattr not found: cannot prove the deletion ledger $f is append-only (install e2fsprogs)" >&2; return 1; }
  flags=$(_ledger_flags "$f") || { echo "install-prod: cannot read the attributes of the deletion ledger $f (lsattr failed: unsupported filesystem?). Put it on ext4/xfs." >&2; return 1; }
  if [[ $flags == *a* ]]; then echo "install-prod: the deletion ledger $f is already append-only"; return 0; fi
  chattr +a -- "$f" || { echo "install-prod: could not set $f append-only (chattr +a failed): the app user could still rewrite or truncate it. Run as root, on ext4/xfs." >&2; return 1; }
  flags=$(_ledger_flags "$f") || { echo "install-prod: cannot read the attributes of the deletion ledger $f after chattr +a (lsattr failed)" >&2; return 1; }
  [[ $flags == *a* ]] || { echo "install-prod: the deletion ledger $f is NOT append-only after chattr +a (read back: $flags)" >&2; return 1; }
  echo "install-prod: set the deletion ledger $f append-only (chattr +a, read back: $flags): the app can add lines; nobody can rewrite, truncate or delete it without root"
}
