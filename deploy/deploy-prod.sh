#!/usr/bin/env bash
# Deploy moonlight-web-stream admin-panel build (378ee0f) to LXC 104 (mws) on pve02.
# Backs up the current binaries/static/config first. Rollback: see the end of this file.
set -euo pipefail

# PKG: tgz with web-server, streamer, static/ (see docs/ADMIN-MONITOR.md); the agent token stays outside the repo
BUILD_DIR="${BUILD_DIR:-/home/ivan/src/mws-build}"
PKG="${PKG:-$BUILD_DIR/mws-admin-378ee0f.tgz}"
TOKEN="$(cat "${AGENT_TOKEN_FILE:-$BUILD_DIR/agent.token}")"

scp -q "$PKG" root@10.8.22.33:/root/mws-admin.tgz
ssh root@10.8.22.33 "pct push 104 /root/mws-admin.tgz /root/mws-admin.tgz && rm -f /root/mws-admin.tgz"

ssh root@10.8.22.33 "pct exec 104 -- env TOKEN='$TOKEN' bash -s" <<'EOF'
set -euo pipefail
if pgrep -x streamer >/dev/null; then echo "a web stream is running, aborting"; exit 1; fi

B=/opt/moonlight-web.bak-20261028
mkdir -p "$B"
cp -a /opt/moonlight-web/web-server /opt/moonlight-web/streamer /opt/moonlight-web/static "$B/"
cp -a /opt/moonlight-web/server/config.json /opt/moonlight-web/server/config.json.bak-20261028

systemctl stop moonlight-web
rm -rf /root/mws-new && mkdir -p /root/mws-new && tar -C /root/mws-new -xzf /root/mws-admin.tgz
rm -rf /opt/moonlight-web/static
cp -r /root/mws-new/static /opt/moonlight-web/static
install -m 755 /root/mws-new/web-server /root/mws-new/streamer /opt/moonlight-web/

python3 - <<'PY'
import json, os
p = '/opt/moonlight-web/server/config.json'
c = json.load(open(p))
c['host_agent'] = {'port': 47995, 'token': os.environ['TOKEN']}
json.dump(c, open(p, 'w'), indent=2)
PY
chown mlw:mlw /opt/moonlight-web/server/config.json

sed -i 's/(v2.10.0)/(v2.10.0 + admin monitor)/' /etc/systemd/system/moonlight-web.service
systemctl daemon-reload
systemctl start moonlight-web
sleep 3
systemctl is-active moonlight-web
curl -sk -o /dev/null -w "monitor.js %{http_code} (expect 200)\n" https://127.0.0.1:8080/component/monitor/index.js
curl -sk -o /dev/null -w "monitor api without login %{http_code} (expect 401)\n" https://127.0.0.1:8080/api/admin/monitor
rm -rf /root/mws-new /root/mws-admin.tgz
EOF

# Rollback (inside LXC 104):
#   systemctl stop moonlight-web
#   cp -a /opt/moonlight-web.bak-20261028/{web-server,streamer} /opt/moonlight-web/
#   rm -rf /opt/moonlight-web/static && cp -a /opt/moonlight-web.bak-20261028/static /opt/moonlight-web/
#   cp -a /opt/moonlight-web/server/config.json.bak-20261028 /opt/moonlight-web/server/config.json
#   systemctl start moonlight-web
