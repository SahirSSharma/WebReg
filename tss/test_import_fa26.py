#!/usr/bin/env python3
"""Offline test for the FA26 TSS importer's lecture grouping.

Run: python3 tss/test_import_fa26.py   -> prints OK and exits 0, or asserts.

WHY THIS FILE EXISTS. On 2026-07-25 TSS stopped sending the `EventKey` field
the importer grouped on. `e.get("EventKey", "001")` dutifully returned the
default for all 20,944 events, so every lecture group in every course merged
into one: MATH 20C's four lectures all became "A00", its discussions were
re-sequenced A01–A26 with no lecture to attach to, and only one final exam
survived per course. ~3,400 sections changed code — enough to empty the saved
schedule of anyone holding one. The import printed its usual success line.

These tests fail if that ever happens again, in either direction: the grouping
must survive a field rename, and an ungroupable dump must stop the import dead
rather than quietly producing a plausible-looking single-group catalog.

Everything here is synthetic — no dependency on the (gitignored) real dumps.
"""
import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import import_fa26 as imp  # noqa: E402

SCHED = ("M, W, F 10:00 AM - 10:50 AM AT PCYNH 106\n"
         "Final Exam 12/05/2026 11:30 AM - 2:29 PM")


def ev(module, abbr, method, **extra):
    e = {"ModuleID": module, "EventAbbr": abbr, "TeachingMethod": method,
         "EventID": f"E-{abbr}", "EventPkgObjid": f"SE{abs(hash(abbr)) % 10**6:06d}",
         "Sched": SCHED, "InstructorName": "Ada Lovelace",
         "EventPkgSeatsAvailable": 10, "EventPkgLimit": 30,
         "EventPkgNumOnWaitl": 0, "EventPkgDisable": False, "Status": "Active"}
    e.update(extra)
    return e


def test_group_key():
    """The lecture group is the first component of EventAbbr."""
    assert imp.group_key(ev("1", "002-003-DI", "DI")) == "002"
    assert imp.group_key(ev("1", "001-000-LE", "LE")) == "001"

    # A dump that still carries the old top-level field keeps working.
    e = {"EventAbbr": "", "EventKey": "004"}
    assert imp.group_key(e) == "004"

    # Neither available -> None. This is the whole point: no default.
    assert imp.group_key({}) is None
    assert imp.group_key({"EventAbbr": "", "EventKey": ""}) is None
    assert imp.group_key({"EventAbbr": "garbled"}) is None


def run_import(modules, events, tmp):
    """Run the importer against a synthetic dump; return parsed output by dept."""
    src, out = tmp / "src", tmp / "out"
    src.mkdir(parents=True, exist_ok=True)
    out.mkdir(parents=True, exist_ok=True)
    (src / "modules.json").write_text(json.dumps(modules))
    (src / "events.json").write_text(json.dumps(events))
    (tmp / "data").mkdir(exist_ok=True)
    imp.SRC, imp.OUT, imp.ROOT = src, out, tmp
    imp.main()
    return {p.stem: json.loads(p.read_text()) for p in out.glob("*.json")}


def test_two_lectures_stay_two_groups(tmp):
    """The exact shape that broke: one course, two lectures, two discussions each.

    Correct output is A00/A01/A02 + B00/B01/B02 with a final per group — NOT
    everything flattened onto the A group.
    """
    modules = [{"ModuleID": "m1", "CourseAbbr": "MATH-020C",
                "CourseTitle": "Calculus III", "CreditsDisplay": "4",
                "DeptApprovalReq": "Not Required"}]
    events = [ev("m1", "001-000-LE", "LE"), ev("m1", "001-001-DI", "DI"),
              ev("m1", "001-002-DI", "DI"), ev("m1", "002-000-LE", "LE"),
              ev("m1", "002-001-DI", "DI"), ev("m1", "002-002-DI", "DI")]

    with tempfile.TemporaryDirectory() as d:
        got = run_import(modules, events, Path(d))

    secs = got["MATH"][0]["sections"]
    codes = [s["code"] for s in secs if s["type"] != "FI"]
    assert codes == ["A00", "A01", "A02", "B00", "B01", "B02"], codes

    # Each lecture group carries its own final exam row.
    finals = [s for s in secs if s["type"] == "FI"]
    assert len(finals) == 2, finals
    assert {s["group"] for s in finals} == {"A", "B"}

    # No duplicate code/type pair among the rows a student can actually hold.
    # (FI rows are exempt: their code is the exam date, and two lecture groups
    # sitting the same final legitimately share it — that is true of the live
    # catalog too. The collapse bug showed up as duplicate *lecture* codes.)
    pairs = [(s["code"], s["type"]) for s in secs if s["type"] != "FI"]
    assert len(pairs) == len(set(pairs)), pairs


def test_ungroupable_dump_is_fatal(tmp):
    """A dump we cannot group must stop the import, not default to one group."""
    modules = [{"ModuleID": "m1", "CourseAbbr": "CSE-101",
                "CourseTitle": "Algorithms", "CreditsDisplay": "4",
                "DeptApprovalReq": "Not Required"}]
    # EventAbbr stripped, no EventKey — exactly the 2026-07-25 payload shape.
    events = [ev("m1", "", "LE"), ev("m1", "", "DI")]

    with tempfile.TemporaryDirectory() as d:
        try:
            run_import(modules, events, Path(d))
        except SystemExit as exc:
            assert exc.code == 1, exc.code
            return
    raise AssertionError(
        "importer accepted an ungroupable dump — this is the 2026-07-25 bug")


def main():
    saved = (imp.SRC, imp.OUT, imp.ROOT)
    try:
        test_group_key()
        test_two_lectures_stay_two_groups(None)
        test_ungroupable_dump_is_fatal(None)
    finally:
        imp.SRC, imp.OUT, imp.ROOT = saved
    print("OK — lecture grouping survives, ungroupable dumps are refused")


if __name__ == "__main__":
    main()
