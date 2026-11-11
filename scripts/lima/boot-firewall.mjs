// Guest boot rules for the Lima template. Reject is final; accept continues
// into later base chains, including patrick_worker at priority -50.
import { sessionUploadBytes } from './connect-proxy.mjs';

export function renderBootNft() {
  return [
    'table inet patrick_boot {',
    '  chain output {',
    '    type filter hook output priority -150; policy accept;',
    '    meta l4proto udp ip daddr 192.168.5.2 udp dport 53 accept',
    '    meta l4proto udp ip daddr 192.168.5.3 udp dport 53 accept',
    '    ip daddr 10.0.0.0/8 reject',
    '    ip daddr 172.16.0.0/12 reject',
    '    ip daddr 192.168.0.0/16 reject',
    '    ip daddr 169.254.0.0/16 reject',
    '    ip6 daddr fc00::/7 reject',
    '    ip6 daddr fe80::/10 reject',
    '  }',
    '}',
    '',
  ].join('\n');
}

export function renderBootScript() {
  const nft = renderBootNft();
  return `#!/bin/sh
set -eu
dest=\${1:-/etc/patrick-worker}
if command -v nft >/dev/null 2>&1; then
  nft delete table inet patrick_boot >/dev/null 2>&1 || true
  nft -f - <<'EOF'
${nft}EOF
elif command -v iptables >/dev/null 2>&1 && command -v ip6tables >/dev/null 2>&1; then
  iptables -N PATRICK_BOOT
  iptables -A PATRICK_BOOT -p udp -d 192.168.5.2 --dport 53 -j ACCEPT
  iptables -A PATRICK_BOOT -p udp -d 192.168.5.3 --dport 53 -j ACCEPT
  iptables -A PATRICK_BOOT -d 10.0.0.0/8 -j REJECT
  iptables -A PATRICK_BOOT -d 172.16.0.0/12 -j REJECT
  iptables -A PATRICK_BOOT -d 192.168.0.0/16 -j REJECT
  iptables -A PATRICK_BOOT -d 169.254.0.0/16 -j REJECT
  iptables -I OUTPUT 1 -j PATRICK_BOOT
  ip6tables -N PATRICK_BOOT
  ip6tables -A PATRICK_BOOT -d fc00::/7 -j REJECT
  ip6tables -A PATRICK_BOOT -d fe80::/10 -j REJECT
  ip6tables -I OUTPUT 1 -j PATRICK_BOOT
else
  echo patrick-boot-firewall-missing >&2
  exit 1
fi
mkdir -p "$dest"
printf '%s\\n' '${sessionUploadBytes}' > "$dest/session-upload-bytes"
chmod 644 "$dest/session-upload-bytes"
`;
}
