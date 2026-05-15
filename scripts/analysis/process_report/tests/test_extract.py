import json
import pytest
from scripts.analysis.process_report.extract import (
    parse_proposals, count_tools, parse_ts, extract_reservations,
)
from scripts.analysis.process_report.db import connect


def test_parse_proposals():
    tj = json.dumps([
        {"name": "submit_proposal", "input": {
            "action": "counter", "is_final": True,
            "issues": [{"name": "price", "value": 23000}],
            "message": "final"}},
        {"name": "send_message", "input": {"message": "hi"}}])
    p = parse_proposals(tj)
    assert len(p) == 1 and p[0]["action"] == "counter"
    assert p[0]["price"] == 23000.0 and p[0]["is_final"] is True
    assert count_tools(tj) == {"send_message": 1, "submit_proposal": 1}


def test_parse_ts():
    d = parse_ts("2026-05-14T13:05:46.565Z")
    assert d is not None and d.year == 2026 and parse_ts(None) is None


def test_reservations_uniform_and_values():
    con = connect()
    res = extract_reservations(con)
    assert len(res) == 40
    one = next(iter(res.values()))
    assert one["buyer_target"] == 21500 and one["buyer_walkaway"] == 23500
    assert one["seller_target"] == 25500 and one["seller_floor"] == 22500
    assert one["seller_target"] > one["seller_floor"] > 0
    sigs = {tuple(sorted(v.items())) for v in res.values()}
    assert len(sigs) == 1


def test_reservations_raise_on_nonuniform(monkeypatch):
    from scripts.analysis.process_report import extract as E
    real = E._packs_for_completers

    def fake(con):
        rows = list(real(con))
        if rows:
            sid, pack = rows[0]
            rows[0] = (sid, pack.replace("21500", "19999"))
        return rows

    monkeypatch.setattr(E, "_packs_for_completers", fake)
    with pytest.raises(ValueError):
        E.extract_reservations(connect())
