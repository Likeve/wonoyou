#!/usr/bin/env bash
# INOU coturn 一键安装（Ubuntu/Debian，需 root）。
# 用法：sudo bash setup-coturn.sh <TURN_SECRET> [TURN_DOMAIN]
# TURN_DOMAIN 可选；填了才会启用 turns:（需要先用 certbot 给该域名签发证书）。
set -euo pipefail

SECRET="${1:?用法: setup-coturn.sh <TURN_SECRET> [TURN_DOMAIN]}"
DOMAIN="${2:-}"

apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y coturn

cat > /etc/turnserver.conf <<EOF
listening-port=3478
tls-listening-port=5349
fingerprint
lt-cred-mech
use-auth-secret
static-auth-secret=$SECRET
realm=inou
min-port=49152
max-port=65535
EOF

if [ -n "$DOMAIN" ]; then
  cat >> /etc/turnserver.conf <<EOF
cert=/etc/letsencrypt/live/$DOMAIN/fullchain.pem
pkey=/etc/letsencrypt/live/$DOMAIN/privkey.pem
EOF
fi

echo 'TURNSERVER_ENABLED=1' > /etc/default/coturn
systemctl enable coturn >/dev/null 2>&1 || true
systemctl restart coturn

if command -v ufw >/dev/null 2>&1; then
  ufw allow 3478/tcp >/dev/null
  ufw allow 3478/udp >/dev/null
  ufw allow 5349/tcp >/dev/null
  ufw allow 5349/udp >/dev/null
  ufw allow 49152:65535/udp >/dev/null
fi

echo "=== 完成 ==="
systemctl is-active coturn
ss -lun | grep -E '3478|5349' || true
