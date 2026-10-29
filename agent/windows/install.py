import base64, os, sys, winrm
host = sys.argv[1]
# usage: WPW=<admin password> AGENT_TOKEN_FILE=<file> python install.py <host>
here = os.path.dirname(os.path.abspath(__file__))
src = open(os.path.join(here, "MwsAgent.cs"), "rb").read()
token = open(os.environ.get("AGENT_TOKEN_FILE", os.path.join(here, "agent.token"))).read().strip()
ps = r'''
$ErrorActionPreference = 'Stop'
$d = 'C:\ProgramData\MwsAgent'
New-Item -ItemType Directory $d -Force | Out-Null
icacls $d /inheritance:r /grant:r 'SYSTEM:(OI)(CI)F' 'Administrators:(OI)(CI)F' | Out-Null
[IO.File]::WriteAllBytes("$d\MwsAgent.cs", [Convert]::FromBase64String([IO.File]::ReadAllText("C:\ProgramData\mwsagent.b64")))
[IO.File]::WriteAllText("$d\agent.conf", "port=47995`r`ntoken=__TOKEN__`r`n")
if (Get-Service MwsAgent -ErrorAction SilentlyContinue) { Stop-Service MwsAgent -Force; Start-Sleep 1 }
$csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$out = & $csc /nologo /optimize /target:exe "/out:$d\MwsAgent.exe" /r:System.ServiceProcess.dll "$d\MwsAgent.cs" 2>&1
if ($LASTEXITCODE -ne 0) { $out; throw 'csc failed' }
if (-not (Get-Service MwsAgent -ErrorAction SilentlyContinue)) {
  sc.exe create MwsAgent binPath= "$d\MwsAgent.exe" start= auto DisplayName= "Moonlight Web Monitor Agent" | Out-Null
  sc.exe failure MwsAgent reset= 86400 actions= restart/5000/restart/5000/restart/5000 | Out-Null
}
Remove-NetFirewallRule -DisplayName 'MwsAgent' -ErrorAction SilentlyContinue
New-NetFirewallRule -DisplayName 'MwsAgent' -Direction Inbound -Protocol TCP -LocalPort 47995 -RemoteAddress 10.8.22.94 -Action Allow | Out-Null
Remove-Item C:\ProgramData\mwsagent.b64
Start-Service MwsAgent
Start-Sleep 4
(Get-Service MwsAgent).Status
$r = Invoke-WebRequest -UseBasicParsing http://127.0.0.1:47995/stats -Headers @{Authorization = 'Bearer __TOKEN__'}
$r.Content
try { Invoke-WebRequest -UseBasicParsing http://127.0.0.1:47995/stats | Out-Null; 'NOAUTH-OK?!' } catch { 'noauth -> ' + $_.Exception.Response.StatusCode }
'''.replace("__TOKEN__", token)
s = winrm.Session(f"http://{host}:5985/wsman", auth=("administrator", os.environ["WPW"]), transport="ntlm")
b64 = base64.b64encode(src).decode()
s.run_ps("Remove-Item C:\\ProgramData\\mwsagent.b64 -ErrorAction SilentlyContinue")
for i in range(0, len(b64), 2400):
    s.run_ps("Add-Content -NoNewline -Path C:\\ProgramData\\mwsagent.b64 -Value '" + b64[i:i+2400] + "'")
r = s.run_ps(ps)
print(r.std_out.decode("utf-8", "replace"))
if r.status_code:
    import re
    print("ERR", re.sub(r"<[^>]+>", " ", r.std_err.decode("utf-8", "replace"))[-2500:])
