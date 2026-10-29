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

