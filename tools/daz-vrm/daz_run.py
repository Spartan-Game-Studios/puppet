#!/usr/bin/env python3
"""Run a DazScript body in a fresh, prompt-less Daz Studio instance ("vpuppet"), started for the one script and
exited after it: no dialog (the Welcome screen, a missing-file prompt) can stall it, and it leaves the user's own
Daz window alone. Headless (`-headless`, an undocumented Daz Studio 6 flag: no window, ~25 s a figure instead of
~10 min); it doesn't exit by itself (App.delayedExit is a no-op there), so it's killed once the done file appears. Usage: WORK=<folder> daz_run.py body.dsa [timeout_s] (the body gets WORK as a variable). The body may call out(str); errors are caught."""
import os, subprocess, sys, time, uuid
DAZ = "/Applications/DAZ 3D/DAZStudio6 64-bit/DAZStudio.app/Contents/MacOS/DAZStudio"
D = os.environ.get("DAZ_RUN_TMP", "/tmp")
body = open(sys.argv[1]).read()
timeout = float(sys.argv[2]) if len(sys.argv) > 2 else 600
tag = uuid.uuid4().hex[:8]
outp, done, sp = f"{D}/out_{tag}.txt", f"{D}/done_{tag}", f"{D}/run_{tag}.dsa"
work = os.path.abspath(os.path.expanduser(os.environ.get("WORK", "."))).replace("\\", "/") + "/"
open(sp, "w").write(f'''var WORK = "{work}";
(function(){{
var __f = new DzFile("{outp}"); __f.open(DzFile.WriteOnly);
function out(s) {{ __f.writeLine(String(s));}}
try {{
{body}
}} catch (e) {{ out("ERROR: " + e + (e.lineNumber ? " line " + e.lineNumber : "")); }}
__f.close();
var __d = new DzFile("{done}"); __d.open(DzFile.WriteOnly); __d.writeLine("ok"); __d.close();
App.delayedExit();
}})();''')
p = subprocess.Popen([DAZ, "-headless", "-instanceName", "vpuppet", "-noPrompt", sp], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
t0 = time.time()
while not os.path.exists(done) and time.time() - t0 < timeout:
    time.sleep(1)
print(open(outp).read() if os.path.exists(outp) else "(no output)", end="")
if not os.path.exists(done):
    print(f"TIMEOUT after {timeout}s")
    p.kill()
try:
    p.wait(3)
except subprocess.TimeoutExpired:
    p.kill()
    p.wait(30)
for f in (sp, outp, done):
    try: os.remove(f)
    except OSError: pass
