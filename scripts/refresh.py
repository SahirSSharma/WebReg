#!/usr/bin/env python3
"""One-command data refresh for the WebReg Course Planner.

Usage:  python3 scripts/refresh.py

Modern TSS opens the Schedule-of-Classes UI as a popup we can't drive, so we
DON'T browse it. Instead we log in once, then read the class data straight
from its backing OData v4 service with the session cookies. You just log in
and close the window — the script does the rest.

The ONLY manual step is the login itself: a REAL browser opens, you do UCSD
SSO + Duo, and the script takes over the instant a session appears — you do
NOT need to browse anywhere or even close the window. Everything before and
after the login is automated.

Steps:
  1. tss/connect.py — launched in the background; a REAL browser opens. You log
     in with UCSD SSO + Duo and stop there. The script polls tss/state.json and
     resumes the moment a live SAP session is captured.
  2. tss/fetch_soc.py — pulls the full FA26 catalog + events directly from the
     yucsd_con_module OData service using the session you just created.
     -> data/tss_fa26/{modules,events}.json
  3. tss/import_fa26.py — maps the dumps into data/parsed/FA26/<DEPT>.json.
  4. Stamps today's date into data/refreshed_at.txt (the site's "Data as of").
  5. scripts/build_site.py — seed -> export -> rebuild site/.

It does NOT touch git. When Claude runs this for you it reviews the result,
commits it to the `staging` branch, and pushes the PREVIEW deploy — the live
site (main) is only updated when you say "ship".
"""
import datetime
import json
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PY = sys.executable
PARSED = ROOT / "data" / "parsed" / "FA26"
STAMP = ROOT / "data" / "refreshed_at.txt"
STATE = ROOT / "tss" / "state.json"


def sh(*cmd, check=True):
    print(f"\n$ {' '.join(str(c) for c in cmd)}")
    return subprocess.run(cmd, cwd=ROOT, check=check)


def _session_live():
    """True once the saved cookies represent a completed SSO+Duo login.

    A SAP_SESSIONID cookie is handed out BEFORE login finishes, so its mere
    presence isn't proof — we confirm with the Fiori launchpad bootstrap
    endpoint (/sap/bc/ui2/start_up), which returns 200 only for an authed
    session. (We deliberately do NOT probe the con_module OData service here:
    it 403s "Access denied" even for a fully-authed session until the SoC app
    is loaded — that authorization is handled later by tss/pull_soc_batch.py.)
    """
    import ssl
    import urllib.request
    try:
        st = json.loads(STATE.read_text())
    except Exception:
        return False
    cook = "; ".join(f"{c['name']}={c['value']}" for c in st.get("cookies", [])
                     if c["domain"].endswith("tss.ucsd.edu"))
    if "SAP_SESSIONID" not in cook:
        return False
    url = "https://tss.ucsd.edu/sap/bc/ui2/start_up"
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    req = urllib.request.Request(url, headers={
        "Cookie": cook, "Accept": "application/json",
        "User-Agent": "Mozilla/5.0"})
    try:
        with urllib.request.urlopen(req, context=ctx, timeout=30) as r:
            return r.status == 200
    except Exception:
        return False


def capture_session(timeout=600):
    """Open the login browser and wait for the user to authenticate.

    This is the ONLY manual step: a real Chromium window opens, the user does
    UCSD SSO + Duo, and we take over the instant a SAP session appears — no
    need to close the window or browse anywhere. Returns the connect.py
    process (kept alive to hold the session) or None if login never landed.
    """
    # Drop any stale session so a leftover dead SAP cookie can't false-positive.
    try:
        STATE.unlink()
    except FileNotFoundError:
        pass
    proc = subprocess.Popen([PY, str(ROOT / "tss" / "connect.py")], cwd=ROOT)
    waited = 0
    while waited < timeout:
        if _session_live():
            print("\nLive session confirmed — taking over, you can leave the "
                  "window open (I'll close it when done).")
            return proc
        if proc.poll() is not None:      # browser closed before login landed
            break
        time.sleep(5)
        waited += 5
    try:
        proc.terminate()
    except Exception:
        pass
    return None


def course_count():
    if not PARSED.is_dir():
        return 0
    n = 0
    for f in PARSED.glob("*.json"):
        try:
            n += len(json.loads(f.read_text()))
        except Exception:
            pass
    return n


def main():
    print("=" * 64)
    print("WebReg data refresh")
    print("=" * 64)
    before = course_count()
    print(f"Current catalog: {before} courses in data/parsed/FA26/")

    # 1. capture the session — browser opens; user only has to LOG IN.
    print("\n>>> A browser is opening. Just log in (UCSD SSO + Duo).\n"
          ">>> You do NOT need to browse anywhere or close the window — "
          "I take over automatically once you're in.\n")
    login = capture_session()
    if login is None:
        print("\nLogin was not detected (window closed or timed out) — "
              "aborting, nothing changed.")
        return 1

    try:
        # 2. pull FA26 by hijacking the SoC app's own $batch. (The old direct
        #    OData GET in tss/fetch_soc.py now 403s — TSS only serves the
        #    con_module entities through the app's multipart batch. See
        #    tss/pull_soc_batch.py.)
        r = sh(PY, ROOT / "tss" / "pull_soc_batch.py", check=False)
        if r.returncode != 0:
            print("\nSoC $batch pull failed. Catalog left unchanged.")
            return 1

        # 3. map the dumps into the parsed catalog
        r = sh(PY, ROOT / "tss" / "import_fa26.py", check=False)
        if r.returncode != 0:
            print("\nImport failed — catalog left unchanged.")
            return 1
    finally:
        # We have the data; release the browser so nothing lingers.
        try:
            login.terminate()
        except Exception:
            pass

    after = course_count()
    print(f"\nCatalog after refresh: {after} courses ({after - before:+d}).")

    # 4. stamp the refresh date
    today = datetime.datetime.now().strftime("%B %-d, %Y at %-I:%M %p PT")
    STAMP.write_text(today + "\n")
    print(f"Stamped data/refreshed_at.txt = {today}")

    # 5. rebuild the static site
    sh(PY, ROOT / "scripts" / "build_site.py")

    print("\n" + "=" * 64)
    print(f"Refresh built locally — data as of {today}, {after} courses.")
    print("Changes are in your working tree (data/ + site/), not yet pushed.")
    print("=" * 64)
    return 0


if __name__ == "__main__":
    sys.exit(main())
