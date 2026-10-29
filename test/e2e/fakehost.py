# Fake Sunshine/Apollo nvhttp host for testing (HTTP 47989 + HTTPS 47984 on 127.0.0.1)
import http.server, ssl, sys, threading, urllib.parse
state = {"game": 1, "calls": []}
def info(paired):
    busy = state["game"] != 0
    return ('<?xml version="1.0" encoding="utf-8"?>\n<root status_code="200"><hostname>FakeHost</hostname><appversion>7.1.431.-1</appversion>'
            '<GfeVersion>3.23.0.74</GfeVersion><uniqueid>11111111-2222-3333-4444-555555555555</uniqueid><HttpsPort>47984</HttpsPort>'
            '<ExternalPort>47989</ExternalPort><MaxLumaPixelsHEVC>1869449984</MaxLumaPixelsHEVC><mac>00:00:00:00:00:00</mac>'
            '<LocalIP>127.0.0.1</LocalIP><ServerCodecModeSupport>1835777</ServerCodecModeSupport>'
            f'<PairStatus>{1 if paired else 0}</PairStatus><currentgame>{state["game"]}</currentgame><currentgameuuid/>'
            f'<state>{"SUNSHINE_SERVER_BUSY" if busy else "SUNSHINE_SERVER_FREE"}</state></root>')
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        https = isinstance(self.connection, ssl.SSLSocket)
        state["calls"].append(("https" if https else "http", path))
        print("CALL", "https" if https else "http", path, flush=True)
        if path == "/serverinfo":
            body = info(https)
        elif path == "/applist" and https:
            body = '<?xml version="1.0" encoding="utf-8"?>\n<root status_code="200"><App><IsHdrSupported>0</IsHdrSupported><AppTitle>Desktop</AppTitle><ID>881448767</ID></App></root>'
        elif path == "/cancel" and https:
            state["game"] = 0
            body = '<?xml version="1.0" encoding="utf-8"?>\n<root status_code="200"><cancel>1</cancel></root>'
        else:
            self.send_response(404); self.end_headers(); return
        data = body.encode()
        self.send_response(200); self.send_header("Content-Type", "application/xml"); self.send_header("Content-Length", str(len(data))); self.end_headers()
        self.wfile.write(data)
    def log_message(self, *a): pass
plain = http.server.ThreadingHTTPServer(("127.0.0.1", 47989), H)
secure = http.server.ThreadingHTTPServer(("127.0.0.1", 47984), H)
ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
ctx.load_cert_chain(sys.argv[1], sys.argv[2])
ctx.verify_mode = ssl.CERT_OPTIONAL
ctx.load_verify_locations(sys.argv[3])
secure.socket = ctx.wrap_socket(secure.socket, server_side=True)
threading.Thread(target=plain.serve_forever, daemon=True).start()
secure.serve_forever()
