#!/usr/bin/env bash
# Deploys this build (v3) to production in LXC 104 (mws) on pve02, replacing v2.10.0 in place:
# same moonlight-web.service, same /opt/moonlight-web, same server/ data.
# Backs up binaries, static and server/ first. Rollback: see the end of this file.
#   PKG=mws-<rev>.tgz deploy/deploy-prod.sh
#   WAIT_IDLE=1 deploy/deploy-prod.sh     wait (up to 2 h) until no v2 streamer is running
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
PVE=root@10.8.22.33
CT=104
PKG="${PKG:-$(ls -t "$REPO"/mws-*.tgz | head -1)}"
STAMP="$(date +%Y%m%d-%H%M)"
echo "package: $PKG, backup suffix: $STAMP"

scp -q "$PKG" "$PVE:/root/mws-prod.tgz"
ssh "$PVE" "pct push $CT /root/mws-prod.tgz /root/mws-prod.tgz && rm -f /root/mws-prod.tgz"

ssh "$PVE" "pct exec $CT -- env STAMP='$STAMP' WAIT_IDLE='${WAIT_IDLE:-0}' bash -s" <<'EOF'
set -euo pipefail
D=/opt/moonlight-web
B=/opt/moonlight-web.bak-$STAMP

# v3 streams in-process, so there is no streamer process to look for: a stream is the only
# thing that gives web-server UDP sockets (WebRTC ICE and the Moonlight RTP/control channels).
# A v2 streamer process still counts.
streaming() {
    pgrep -x streamer >/dev/null && return 0
    local pid
    pid="$(pgrep -x web-server)" || return 1
    # Not grep -q: exiting early can SIGPIPE ss and fail the pipeline under pipefail
    ss -uanp | grep -F "pid=$pid," >/dev/null
}

if [ "$WAIT_IDLE" = 1 ]; then
    for _ in $(seq 1 240); do
        streaming || break
        echo "a stream is running, waiting"
        sleep 30
    done
    if streaming; then echo "still streaming after 2 h, aborting"; exit 1; fi
fi

mkdir -p "$B"
cp -a "$D/web-server" "$D/static" "$D/server" "$B/"
[ -e "$D/streamer" ] && cp -a "$D/streamer" "$B/"
echo "backup: $B"

rm -rf /root/mws-new && mkdir -p /root/mws-new && tar -C /root/mws-new -xzf /root/mws-prod.tgz

systemctl stop moonlight-web
pkill -x streamer 2>/dev/null || true

install -m 755 /root/mws-new/web-server "$D/web-server"
rm -rf "$D/static" && cp -r /root/mws-new/static "$D/static"
# v3 runs streams in-process
rm -f "$D/streamer"

# Drop the config keys v3 removed
python3 - <<'PY'
import json
p = "/opt/moonlight-web/server/config.json"
c = json.load(open(p))
c.pop("streamer_path", None)
c.pop("default_settings", None)
c.get("webrtc", {}).pop("network_types", None)
for key in ("default_role_id", "default_user_id"):
    if c.get("web_server", {}).get(key) is not None:
        print(f"note: web_server.{key} was set, v3 keeps it in data.json: set it again in the admin panel")
    c.get("web_server", {}).pop(key, None)
json.dump(c, open(p, "w"), indent=2)
PY
chown mlw:mlw "$D/server/config.json" && chmod 600 "$D/server/config.json"

sed -i 's/^Description=.*/Description=moonlight-web-stream (v3.0.1 fork)/' /etc/systemd/system/moonlight-web.service
systemctl daemon-reload
systemctl start moonlight-web
sleep 4
systemctl is-active moonlight-web
journalctl -u moonlight-web --no-pager -n 8 -o cat | cut -c1-200
curl -sk -o /dev/null -w "index %{http_code} (expect 200)\n" https://127.0.0.1:8080/
curl -sk -o /dev/null -w "monitor without login %{http_code} (expect 401)\n" https://127.0.0.1:8080/api/admin/monitor
rm -rf /root/mws-new /root/mws-prod.tgz
echo "rollback backup: $B"
EOF

# Rollback (inside LXC 104), B = the backup printed above:
#   systemctl stop moonlight-web
#   cp -a $B/web-server $B/streamer /opt/moonlight-web/
#   rm -rf /opt/moonlight-web/static && cp -a $B/static /opt/moonlight-web/
#   rm -rf /opt/moonlight-web/server && cp -a $B/server /opt/moonlight-web/
#   systemctl start moonlight-web
