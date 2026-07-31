#!/usr/bin/env python3
"""Map the raw FA26 TSS dump into WebReg's parsed format.

Input  : data/tss_fa26/{modules,events}.json  (from the TSS OData dump)
Output : data/parsed/FA26/<DEPT>.json          (frozen seed.py schema)
         + FA26 entry (source=tss, is_default) in data/terms.json

TSS data model (SAP SLcM, service yucsd_con_module):
  YUCSD_CON_MODULE  = one row per course offering (CourseAbbr, title, credits,
                      department, ModuleID).
  YUCSD_CON_EVENTS  = one row per meeting-within-a-package. Events sharing an
                      EventPkgDisplayID (e.g. SE00154263 = "CSE-003 (P-001-001)")
                      form ONE enrollable section: a lecture (LE) plus its
                      discussion (DI) / lab (LA), and the package carries the
                      seats/limit/waitlist a student books against.
  The human-readable `Sched` string carries days, times, modality, room, and a
  "Final Examination …" line — parsed here into meeting + FI rows.

WebReg mapping:
  course  = module (subject+number from CourseAbbr like "CSE-003").
  group   = lecture number ("001" -> letter A, "002" -> B), read off EventAbbr
            ("<lecture>-<subsection>-<method>", e.g. "002-003-DI"). TSS also
            used to publish this as a top-level EventKey; that field vanished
            from the payload between the 2026-07-23 and 2026-07-25 pulls.
            See group_key() — a missing key is now fatal, not a default.
  rows    = deduped meetings under that group: lecture "A00", then each
            enrollable package as a sub-row "A01", "A02"… (the row that carries
            the Enroll button + seats), plus a final-exam FI row.
"""
import json
import re
from collections import OrderedDict, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "data" / "tss_fa26"
OUT = ROOT / "data" / "parsed" / "FA26"

DAY_MAP = {"M": "M", "MO": "M", "TU": "Tu", "W": "W", "WE": "W",
           "TH": "Th", "F": "F", "FR": "F", "SA": "Sa", "SU": "Su"}
DAY_ORDER = ["M", "Tu", "W", "Th", "F", "Sa", "Su"]

# TSS truncates building names to 40 characters; restore the full names.
BUILDING_FIX = {
    "Computer Science and Engineering Buildin":
        "Computer Science and Engineering Building",
    "Structural and Materials Engineering Bui":
        "Structural and Materials Engineering Building",
    "Science and Engineering Research Facilit":
        "Science and Engineering Research Facility",
    "MCTF - Marine Conservation and Technolog":
        "MCTF - Marine Conservation and Technology",
    "Medical Education and Telemedicine Cente":
        "Medical Education and Telemedicine Center",
    # ambiguous truncated designator ("- G"/"- N") — drop to the base name
    "Extended Studies and Public Programs - G":
        "Extended Studies and Public Programs",
    "Extended Studies and Public Programs - N":
        "Extended Studies and Public Programs",
}


def fix_building(b):
    return BUILDING_FIX.get(b, b)


def course_parts(abbr):
    """'CSE-003' -> ('CSE','3'); '010R' keeps suffix -> '10R'."""
    if "-" in abbr:
        subj, num = abbr.split("-", 1)
    else:
        m = re.match(r"([A-Za-z]+)(.*)", abbr)
        subj, num = (m.group(1), m.group(2)) if m else (abbr, "")
    m = re.match(r"0*(\d+)([A-Za-z]*)$", num.strip())
    if m:
        num = m.group(1) + m.group(2).upper()
    else:
        num = num.strip().lstrip("0") or num.strip()
    return subj.strip().upper(), num


def to_wr_time(t):
    """'08:00 AM' -> '8:00a'; '05:00 PM' -> '5:00p'."""
    m = re.match(r"(\d{1,2}):(\d{2})\s*([AP])M", t.strip(), re.I)
    if not m:
        return ""
    h, mn, ap = int(m.group(1)), m.group(2), m.group(3).lower()
    return f"{h}:{mn}{ap}"


def norm_days(chunk):
    """'Tu, Th' / 'MWF' / 'M Tu W' -> 'TuTh' / 'MWF'."""
    toks = re.findall(r"Su|Sa|Tu|Th|Mo|We|Fr|M|W|F", chunk)
    out = []
    for t in toks:
        d = DAY_MAP.get(t.upper())
        if d and d not in out:
            out.append(d)
    return "".join(sorted(out, key=DAY_ORDER.index))


_LOC = re.compile(r"@\s*(.+?)\s+Room\s+(\S+)\s*$", re.I)
_MEET = re.compile(
    r"^([A-Za-z, ]+?)\s+(\d{1,2}:\d{2}\s*[AP]M)\s*-\s*(\d{1,2}:\d{2}\s*[AP]M)\s*(.*)$",
    re.I)


def parse_sched(sched):
    """Return (meetings, final) from the Sched string.

    meetings: list of {days,t0,t1,building,room}. final: same or None.
    """
    meetings, final = [], None
    for line in (sched or "").split("\n"):
        line = line.strip()
        if not line:
            continue
        fm = re.match(r"Final Exam\w*\s+(\d{1,2}/\d{1,2}/\d{2,4})\s+"
                      r"(\d{1,2}:\d{2}\s*[AP]M)\s*-\s*(\d{1,2}:\d{2}\s*[AP]M)",
                      line, re.I)
        if fm:
            final = {"date": fm.group(1), "t0": to_wr_time(fm.group(2)),
                     "t1": to_wr_time(fm.group(3))}
            continue
        mm = _MEET.match(line)
        if not mm:
            continue
        days = norm_days(mm.group(1))
        tail = mm.group(4).strip()
        building, room = "", ""
        lm = _LOC.search(tail)
        if lm:
            building, room = fix_building(lm.group(1).strip()), lm.group(2).strip()
        elif "online" in tail.lower():
            building = "RCLAS" if "live" in tail.lower() else "ONLINE"
        meetings.append({"days": days, "t0": to_wr_time(mm.group(2)),
                         "t1": to_wr_time(mm.group(3)),
                         "building": building, "room": room})
    return meetings, final


def clean_instr(name, placeholders=frozenset()):
    name = (name or "").strip()
    # A flagged department-of-record placeholder (see detect_placeholder_
    # instructors) is blanked so the frontend renders it as "Staff", matching
    # real WebReg for sections with no instructor assigned yet.
    return "" if name in placeholders else name


def _time_min(t):
    """WebReg time '2:00p' / '11:30a' -> minutes since midnight (or None)."""
    m = re.match(r"(\d{1,2}):(\d{2})([ap])$", t or "")
    if not m:
        return None
    h, mn, ap = int(m.group(1)), int(m.group(2)), m.group(3)
    if ap == "p" and h != 12:
        h += 12
    if ap == "a" and h == 12:
        h = 0
    return h * 60 + mn


def detect_placeholder_instructors(events, mod_by_id):
    """Return instructor names TSS uses as a department's "instructor of record".

    When a section has no real instructor assigned yet, UCSD's TSS fills in the
    department chair / graduate coordinator as a placeholder. That single name
    then shows up across many unrelated courses — frequently scheduled at the
    SAME meeting time — which is physically impossible for one human (this is
    what made "Michael Holst teaching 16 classes" go viral on r/UCSD). Real
    WebReg shows these sections as "Staff".

    We flag a name only when its meetings overlap in time across >= 3 DISTINCT
    courses. The >= 3 threshold is deliberate: a genuine cross-listing (one
    class offered under two course codes at the same time) produces exactly 2
    overlapping "courses" and must NOT be flagged, whereas no real instructor is
    ever in three different classes at once. This keeps real professors who
    teach a placeholder-adjacent section untouched — only the placeholder name
    is blanked.
    """
    slots = defaultdict(list)
    for e in events:
        name = (e.get("InstructorName") or "").strip()
        if not name:
            continue
        abbr = mod_by_id.get(e.get("ModuleID"), {}).get("CourseAbbr", "")
        for mt in parse_sched(e.get("Sched", ""))[0]:
            a, b = _time_min(mt["t0"]), _time_min(mt["t1"])
            if a is None or b is None or not mt["days"]:
                continue
            days = frozenset(re.findall(r"Su|Sa|Tu|Th|M|W|F", mt["days"]))
            # group_key, not the raw EventKey field. This is the same 2026-07-25
            # hazard as in main(): with EventKey gone every event answered None,
            # so the "same lecture group of the same course" test below widened
            # to "same course" and two different lectures at the same hour
            # stopped counting as a conflict. On the 2026-07-25 dump it happened
            # to flag the same 19 names either way, so nothing shipped wrong —
            # but it was luck, not logic, and the next dump need not be as kind.
            slots[name].append((abbr, group_key(e), days, a, b))

    flagged = set()
    for name, ss in slots.items():
        # dedupe identical meetings so one lecture's repeats don't self-conflict
        uniq = list({(s[0], s[1], tuple(sorted(s[2])), s[3]): s
                     for s in ss}.values())
        conflict_courses = set()
        for i in range(len(uniq)):
            ci, ki, di, ai, bi = uniq[i]
            for j in range(i + 1, len(uniq)):
                cj, kj, dj, aj, bj = uniq[j]
                if (ci, ki) == (cj, kj):
                    continue  # same lecture group of the same course
                if di & dj and ai < bj and aj < bi:
                    conflict_courses |= {ci, cj}
        if len(conflict_courses) >= 3:
            flagged.add(name)
    return flagged


def group_key(e):
    """Which lecture group this meeting belongs to — "001", "002", …

    Returns None when the event carries no usable grouping information.

    WHY THIS IS ITS OWN FUNCTION, AND WHY None MATTERS. This used to be
    `e.get("EventKey", "001")` inline. On 2026-07-25 TSS stopped sending
    EventKey at all, so every event in every course silently fell into the one
    default group: MATH 20C's four lectures all became "A00", its 26
    discussions were re-sequenced A01–A26 with no lecture to hang off, and only
    one final exam survived per course instead of one per group. ~3,400
    sections changed code. Nothing failed, nothing warned — the import printed
    its usual success line and the export looked structurally fine.

    A default value turned a schema change into corrupt data. So there is no
    default any more: an event we cannot place is returned as None and main()
    refuses to write anything.
    """
    # "<lecture>-<subsection>-<method>", e.g. "002-003-DI" -> "002".
    parts = (e.get("EventAbbr") or "").split("-")
    if len(parts) == 3 and parts[0].strip():
        return parts[0].strip()
    # Older dumps carried it as a top-level field; keep reading it if it's back.
    key = (e.get("EventKey") or "").strip()
    return key or None


def main():
    modules = json.load(open(SRC / "modules.json"))
    events = json.load(open(SRC / "events.json"))
    OUT.mkdir(parents=True, exist_ok=True)

    mod_by_id = {m["ModuleID"]: m for m in modules}
    ev_by_mod = defaultdict(list)
    for e in events:
        ev_by_mod[e["ModuleID"]].append(e)

    # Refuse to import a dump we can't group. See group_key() — the 2026-07-25
    # corruption was a missing field quietly becoming a default, so this runs
    # before any output is produced rather than warning after the fact.
    ungrouped = [e for e in events if group_key(e) is None]
    if ungrouped:
        print(f"⛔ {len(ungrouped)} of {len(events)} events carry no lecture "
              f"group (no 3-part EventAbbr, no EventKey).")
        print("   Importing them would collapse every affected course into a "
              "single 'A' group and renumber its sections.")
        for e in ungrouped[:5]:
            print(f"   ModuleID={e.get('ModuleID')} "
                  f"EventAbbr={e.get('EventAbbr')!r} "
                  f"TeachingMethod={e.get('TeachingMethod')!r}")
        print("   TSS likely changed its schema again — teach group_key() the "
              "new field before re-running.")
        raise SystemExit(1)

    placeholder_instr = detect_placeholder_instructors(events, mod_by_id)
    if placeholder_instr:
        print(f"Blanked {len(placeholder_instr)} instructor-of-record "
              f"placeholder(s) -> Staff: "
              f"{', '.join(sorted(placeholder_instr))}")

    by_dept = defaultdict(list)
    n_courses = n_sections = 0

    for mid, m in mod_by_id.items():
        subj, num = course_parts(m["CourseAbbr"])
        evs = ev_by_mod.get(mid, [])
        course = {"subject": subj, "number": num,
                  "title": m.get("CourseTitle", ""),
                  "units": m.get("CreditsDisplay", ""),
                  "restriction": "" if m.get("DeptApprovalReq") == "Not Required"
                                 else "D", "sections": []}

        # group events by lecture number -> letter group
        groups = defaultdict(list)
        for e in evs:
            groups[group_key(e)].append(e)

        for gi, (key, gevs) in enumerate(sorted(groups.items())):
            letter = chr(ord("A") + gi)
            # A physical meeting can be reused across enrollment packages
            # (one lecture/discussion serving several lab combos) — dedupe by
            # EventID so each real meeting is emitted once, keeping the package
            # with the most seats for its seat display.
            phys = OrderedDict()
            for e in gevs:
                eid = e.get("EventID")
                cur = phys.get(eid)
                if cur is None or (e.get("EventPkgSeatsAvailable") or 0) > (
                        cur.get("EventPkgSeatsAvailable") or 0):
                    phys[eid] = e

            lectures = [e for e in phys.values()
                        if e.get("TeachingMethod") == "LE"]
            subs = [e for e in phys.values()
                    if e.get("TeachingMethod") != "LE"]
            final_row = None
            has_subs = bool(subs)

            def emit(e, code, mtype, enrollable):
                nonlocal n_sections, final_row
                meets, final = parse_sched(e.get("Sched", ""))
                if final and not final_row:
                    final_row = final
                first = True
                for mt in (meets or [{"days": "", "t0": "", "t1": "",
                                      "building": "", "room": ""}]):
                    course["sections"].append({
                        "section_id": str(e.get("EventPkgObjid", ""))
                                      if (enrollable and first) else "",
                        "group": letter, "type": mtype, "code": code,
                        "days": mt["days"], "time_start": mt["t0"],
                        "time_end": mt["t1"], "building": mt["building"],
                        "room": mt["room"],
                        "instructor": clean_instr(e.get("InstructorName", ""),
                                                  placeholder_instr),
                        "avail": e.get("EventPkgSeatsAvailable")
                                 if (enrollable and first) else None,
                        "limit": e.get("EventPkgLimit")
                                 if (enrollable and first) else None,
                        "waitlist": e.get("EventPkgNumOnWaitl", 0)
                                    if (enrollable and first) else 0,
                        "enrollable": 1 if (enrollable and first
                                            and not e.get("EventPkgDisable")) else 0,
                        "cancelled": e.get("Status") == "Cancelled",
                        "note": ""})
                    n_sections += 1
                    first = False

            # lecture -> A00 (non-enrollable when sub-sections exist)
            for e in lectures:
                emit(e, f"{letter}00", "LE", enrollable=not has_subs)

            # sub-sections: discussions A01.. , labs A50.. , others A0x
            di = la = other = 0
            for e in sorted(subs, key=lambda x: x.get("EventAbbr", "")):
                tm = e.get("TeachingMethod", "DI")
                if tm == "LA":
                    la += 1
                    code = f"{letter}{49 + la:02d}"
                elif tm == "DI":
                    di += 1
                    code = f"{letter}{di:02d}"
                else:
                    other += 1
                    code = f"{letter}{80 + other:02d}"
                emit(e, code, tm, enrollable=True)

            if final_row:
                course["sections"].append({
                    "section_id": "", "group": letter, "type": "FI",
                    "code": final_row["date"], "days": "",
                    "time_start": final_row["t0"], "time_end": final_row["t1"],
                    "building": "", "room": "", "instructor": "",
                    "avail": None, "limit": None, "waitlist": 0,
                    "enrollable": 0, "cancelled": 0, "note": ""})
                n_sections += 1

        if course["sections"]:
            by_dept[subj].append(course)
            n_courses += 1

    for dept, courses in by_dept.items():
        courses.sort(key=lambda c: (
            re.sub(r"\D", "", c["number"]).zfill(4), c["number"]))
        (OUT / f"{dept}.json").write_text(json.dumps(courses, indent=1))

    # terms.json: FA26 default, keep others
    terms_path = ROOT / "data" / "terms.json"
    terms = json.loads(terms_path.read_text()) if terms_path.exists() else []
    terms = [t for t in terms if t["code"] != "FA26"]
    for t in terms:
        t["is_default"] = 0
    terms.insert(0, {"code": "FA26", "name": "Fall 2026", "source": "tss",
                     "is_default": 1, "sort_key": 100})
    terms_path.write_text(json.dumps(terms, indent=1))

    print(f"FA26: {n_courses} courses, {n_sections} section rows, "
          f"{len(by_dept)} departments -> {OUT}")


if __name__ == "__main__":
    main()
