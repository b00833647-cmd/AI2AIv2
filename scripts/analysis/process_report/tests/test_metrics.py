from scripts.analysis.process_report.db import connect
from scripts.analysis.process_report import metrics as M


def test_frames_shapes_and_invariants():
    con = connect()
    bf = M.bargaining_frame(con)
    assert len(bf) == 40
    assert {"opening_spread", "n_concessions", "turns_to_deal"} <= set(bf.columns)

    sf = M.surplus_frame(con)
    assert len(sf) >= 20
    bs = sf["buyer_share_of_surplus"].dropna()
    assert ((bs >= 0) & (bs <= 1)).mean() > 0.8

    tf = M.tempo_frame(con)
    assert len(tf) == 40 and tf["orch_token_share"].between(0, 1).all()

    of = M.orchestrator_frame(con)
    assert len(of) == 40 and of["alternation_rate"].dropna().between(0, 1).all()

    uf = M.ux_frame(con)
    assert len(uf) == 40 and (uf["engine_dwell_s"] >= 0).all()

    hc = M.human_cadence(con)
    assert set(hc["role"]) <= {"buyer", "seller"} and len(hc) <= 20
    assert (hc["n_human_turns"] >= 0).all()
