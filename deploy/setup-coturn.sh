#!/usr/bin/env bash
# INOU coturn 一键安装（需 root）。
# 支持 apt(Debian/Ubuntu) 与 dnf(RHEL/OpenCloudOS)。
# 用法：sudo bash setup-coturn.sh <TURN_SECRET> <公网IP> [内网IP]
#   TURN_SECRET: 与 Vercel 的 TURN_SECRET 保持一致
#   公网IP:      服务器公网地址（NAT 场景必填，中继会对外广播这个 IP）
#   内网IP:      可选，默认自动取默认路由的 IPv4
set -euo pipefail

SECRET="${1:?用法: setup-coturn.sh <TURN_SECRET> <公网IP> [内网IP]}"
PUBLIC_IP="${2:?缺少公网IP参数}"
PRIVATE_IP="${3:-}"

if [ -z "$PRIVATE_IP" ]; then
  PRIVATE_IP=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i=1;i<=NF;i++) if ($i=="src") {print $(i+1); exit}}')
fi
if [ -z "$PRIVATE_IP" ]; then
  echo "无法自动获取内网IP，请作为第三个参数手动传入"
  exit 1
fi

if command -v dnf >/dev/null 2>&1; then
  dnf install -y coturn
elif command -v apt-get >/dev/null 2>&1; then
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y coturn
else
  echo "未找到 dnf 或 apt-get，无法安装 coturn"
  exit 1
fi

cat > /etc/turnserver.conf <<EOF
listening-port=3478
fingerprint
use-auth-secret
static-auth-secret=$SECRET
realm=inou
min-port=49152
max-port=65535
no-cli
EOF

# 关键：监听/中继/外部映射用命令行参数传入，避免个别 coturn 版本忽略配置文件中的 IP 选项。
cat > /etc/systemd/system/coturn.service <<EOF
[Unit]
Description=coturn TURN server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/turnserver -c /etc/turnserver.conf --listening-ip=$PRIVATE_IP --relay-ip=$PRIVATE_IP --external-ip=$PUBLIC_IP/$PRIVATE_IP
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable coturn
systemctl restart coturn

echo "=== 完成 ==="
echo "内网IP: $PRIVATE_IP  公网IP: $PUBLIC_IP"
systemctl is-active coturn
ss -lun | grep 3478 || true
