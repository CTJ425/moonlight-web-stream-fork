#!/usr/bin/env bash
# Starts this build as a test instance next to production in LXC 104 (mws) on pve02:
# https://10.8.22.94:8081, WebRTC UDP 40101-40150, on a copy of the production server/ data.
# Production (:8080, moonlight-web.service) is not touched.
#   PKG=mws-<rev>.tgz deploy/test-lxc.sh          install and start
#   deploy/test-lxc.sh stop                        stop and remove the test instance
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
PVE=root@10.8.22.33
CT=104

if [ "${1:-}" = "stop" ]; then
    ssh "$PVE" "pct exec $CT -- bash -c 'systemctl stop mws-v3-test 2>/dev/null; rm -rf /opt/mws-v3-test; echo removed'"
    exit 0
fi

PKG="${PKG:-$(ls -t "$REPO"/mws-*.tgz | head -1)}"
echo "package: $PKG"

scp -q "$PKG" "$PVE:/root/mws-v3-test.tgz"
ssh "$PVE" "pct push $CT /root/mws-v3-test.tgz /root/mws-v3-test.tgz && rm -f /root/mws-v3-test.tgz"

ssh "$PVE" "pct exec $CT -- bash -s" <<'EOF'
set -euo pipefail
T=/opt/mws-v3-test
P=/opt/moonlight-web/server

systemctl stop mws-v3-test 2>/dev/null || true
rm -rf "$T" && mkdir -p "$T/server"
tar -C "$T" -xzf /root/mws-v3-test.tgz && rm -f /root/mws-v3-test.tgz
chmod 755 "$T/web-server"
cp -a "$P/data.json" "$P/cert.pem" "$P/key.pem" "$T/server/"

# v3 config: drop the keys v3 removed (network_types, default_*_id, streamer_path, default_settings)
python3 - <<'PY'
import json
old = json.load(open("/opt/moonlight-web/server/config.json"))
webrtc = {k: v for k, v in old["webrtc"].items() if k != "network_types"}
webrtc["port_range"] = {"min": 40101, "max": 40150}
web = {k: v for k, v in old["web_server"].items() if k not in ("default_role_id", "default_user_id", "certificate")}
web["bind_address"] = "0.0.0.0:8081"
new = {
    "data_storage": {"type": "json", "path": "server/data.json",
                     "session_expiration_check_interval": {"secs": 300, "nanos": 0}},
    "webrtc": webrtc,
    "web_server": web,
    "moonlight": old["moonlight"],
    "log": old["log"],
}
if "host_agent" in old:
    new["host_agent"] = old["host_agent"]
json.dump(new, open("/opt/mws-v3-test/server/config.json", "w"), indent=2)
print("host_agent token set:", bool(new.get("host_agent", {}).get("token")))
PY
chown -R mlw:mlw "$T"
chmod 600 "$T/server/config.json" "$T/server/key.pem" "$T/server/data.json"

# Same settings as moonlight-web.service, except the port range
systemd-run --unit mws-v3-test --uid mlw --gid mlw -p WorkingDirectory="$T" \
    -E SSL_CERTIFICATE=./server/cert.pem -E SSL_PRIVATE_KEY=./server/key.pem \
    -E WEBRTC_NAT_1TO1_HOST=10.8.22.94 -E DISABLE_DEFAULT_WEBRTC_ICE_SERVERS=true \
    "$T/web-server" run
sleep 3
systemctl is-active mws-v3-test
journalctl -u mws-v3-test --no-pager -n 15 -o cat | cut -c1-200
curl -sk -o /dev/null -w "index %{http_code} (expect 200)\n" https://127.0.0.1:8081/
curl -sk -o /dev/null -w "monitor without login %{http_code} (expect 401)\n" https://127.0.0.1:8081/api/admin/monitor
EOF

echo
echo "Test instance: https://10.8.22.94:8081 (log in with the production account)"
echo "Logs: ssh $PVE pct exec $CT -- journalctl -u mws-v3-test -f"
echo "Remove: $0 stop"
