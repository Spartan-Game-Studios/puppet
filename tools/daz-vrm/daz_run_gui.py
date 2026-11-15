# Run a DazScript body in a separate Daz GUI instance ("vpuppetcheck"), hidden by
# private-run (the private-windows plugin; drop it to see the window), then
# close it. For checks that need Daz's GUI (menus, panes), which headless Daz
# doesn't have. Leaves the user's own Daz window alone.
#   python3 daz_run_gui.py check_ui.dsa [timeout_s]
import os, sys, time, uuid, subprocess
DAZ = "/Applications/DAZ 3D/DAZStudio6 64-bit/DAZStudio.app/Contents/MacOS/DAZStudio"
D = os.environ.get("DAZ_RUN_TMP", "/tmp"); body = open(sys.argv[1]).read(); tag = uuid.uuid4().hex[:8]
outp, done, sp = f"{D}/out_{tag}.txt", f"{D}/done_{tag}", f"{D}/run_{tag}.dsa"
open(sp, "w").write(f'''(function(){{ var __f = new DzFile("{outp}"); __f.open(DzFile.WriteOnly);
function out(s) {{ __f.writeLine(String(s)); }}
try {{ {body} }} catch (e) {{ out("ERROR: " + e + (e.lineNumber ? " line " + e.lineNumber : "")); }}
__f.close(); var __d = new DzFile("{done}"); __d.open(DzFile.WriteOnly); __d.writeLine("ok"); __d.close(); }})();''')
p = subprocess.Popen(["private-run", "--", DAZ, "-instanceName", "vpuppetcheck", "-noPrompt", sp], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
t0 = time.time()
while not os.path.exists(done) and time.time() - t0 < float(sys.argv[2] if len(sys.argv) > 2 else 240): time.sleep(1)
print(open(outp).read() if os.path.exists(outp) else "(no output)", end="")
subprocess.run(["pkill", "-f", "instanceName vpuppetcheck"]); p.kill()
