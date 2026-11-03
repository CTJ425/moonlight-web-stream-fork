import os, sys, winrm
host, script = sys.argv[1], open(sys.argv[2], encoding="utf-8").read()
s = winrm.Session(f"http://{host}:5985/wsman", auth=(os.environ.get("WUSER","administrator"), os.environ["WPW"]), transport="ntlm")
r = s.run_ps(script)
sys.stdout.write(r.std_out.decode("utf-8", "replace"))
err = r.std_err.decode("utf-8", "replace")
if r.status_code: sys.stdout.write("\nSTDERR:\n" + err[:3000])
