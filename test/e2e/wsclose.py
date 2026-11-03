import importlib.util, json, os, subprocess, sys, time
spec = importlib.util.spec_from_file_location("e2e_helpers", "/root/e2e_helpers.py")
h = importlib.util.module_from_spec(spec); spec.loader.exec_module(h)
data = json.load(open("/opt/mws-test/server/data.json"))
hid = int(next(iter(data["hosts"])))
app_id = h.api(f"/apps?host_id={hid}")["apps"][0]["app_id"]
init = {"Init": {"host_id": hid, "app_id": app_id, "video_frame_queue_size": 2, "audio_sample_queue_size": 2}}
mode = sys.argv[1]
ws = h.ws_open(init)
time.sleep(3)
print(mode, "before:", len(h.api("/admin/monitor")["streams"]), h.streamers())
if mode == "closeframe":
    mask = os.urandom(4); payload = (1000).to_bytes(2, "big")
    ws.sendall(bytes([0x88, 0x80 | len(payload)]) + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(payload)))
    time.sleep(0.5)
    try: ws.unwrap()
    except Exception as e: print("unwrap:", type(e).__name__)
if mode == "frameonly":
    mask = os.urandom(4); payload = (1000).to_bytes(2, "big")
    ws.sendall(bytes([0x88, 0x80 | len(payload)]) + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(payload)))
    time.sleep(4)
    print(mode, "after close frame, tcp still open:", len(h.api("/admin/monitor")["streams"]), h.streamers())
ws.close()
time.sleep(1)
print(subprocess.run("ss -tn state established '( sport = :8081 )'", shell=True, capture_output=True, text=True).stdout.strip())
time.sleep(45 if mode == "raw" else 3)
print(mode, "after:", len(h.api("/admin/monitor")["streams"]), h.streamers())
