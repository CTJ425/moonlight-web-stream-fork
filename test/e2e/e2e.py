# Runs inside the mws LXC against the test instance (127.0.0.1:8081), which only knows the fake host
import base64, json, os, socket, ssl, subprocess, time, urllib.request

BASE = "https://127.0.0.1:8081/api"
HDR = {"X-Test-User": "ivan"}
CTX = ssl._create_unverified_context()

def api(path, method="GET", body=None):
    headers = dict(HDR)
    if body is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(BASE + path, method=method, headers=headers,
                                 data=json.dumps(body).encode() if body is not None else None)
    return json.load(urllib.request.urlopen(req, context=CTX, timeout=40))

def ws_open(init):
    s = CTX.wrap_socket(socket.create_connection(("127.0.0.1", 8081)), server_hostname="127.0.0.1")
    key = base64.b64encode(os.urandom(16)).decode()
    s.sendall(("GET /api/host/stream HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
               f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\nX-Test-User: ivan\r\n\r\n").encode())
    resp = s.recv(4096).decode(errors="replace")
    assert resp.startswith("HTTP/1.1 101"), resp
    payload = json.dumps(init).encode()
    mask = os.urandom(4)
    if len(payload) > 125:
        hdr = bytes([0x81, 0x80 | 126]) + len(payload).to_bytes(2, "big")
    else:
        hdr = bytes([0x81, 0x80 | len(payload)])
    s.sendall(hdr + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(payload)))
    return s

def streamers():
    return subprocess.run(["pgrep", "-f", "/opt/mws-test/streamer|^./streamer$"], capture_output=True, text=True).stdout.split()

data = json.load(open("/opt/mws-test/server/data.json"))
assert len(data["hosts"]) == 1, "test instance must only know the fake host"
hid, host = next(iter(data["hosts"].items()))
assert host["address"] == "127.0.0.1", "test instance must only know the fake host"

apps = api(f"/apps?host_id={hid}")["apps"]
print("apps:", [(a["title"], a["app_id"]) for a in apps])
desktop = apps[0]

print("streamers before:", streamers())

# client disconnect must stop the streamer (was leaking before)
ws0 = ws_open({"Init": {"host_id": int(hid), "app_id": desktop["app_id"], "video_frame_queue_size": 2, "audio_sample_queue_size": 2}})
time.sleep(3)
print("disconnect test, registered:", len(api("/admin/monitor")["streams"]), "streamers:", streamers())
ws0.close()
time.sleep(4)
print("disconnect test after close, registered:", len(api("/admin/monitor")["streams"]), "streamers:", streamers())
ws1 = ws_open({"Init": {"host_id": int(hid), "app_id": desktop["app_id"], "video_frame_queue_size": 2, "audio_sample_queue_size": 2}})
ws2 = ws_open({"Init": {"host_id": int(hid), "app_id": desktop["app_id"], "video_frame_queue_size": 2, "audio_sample_queue_size": 2}})
time.sleep(3)
print("registered streams:", api("/admin/monitor")["streams"])
print("streamers during:", streamers())

t0 = time.time()
res = api("/admin/terminate_all", "POST")
print(f"terminate_all ({time.time() - t0:.1f}s):", res)
time.sleep(4)
print("registered streams after:", api("/admin/monitor")["streams"])
print("streamers after:", streamers())
ws1.settimeout(1)
try:
    print("ws1 recv after terminate:", ws1.recv(64))
except Exception as e:
    print("ws1 recv after terminate:", type(e).__name__)
