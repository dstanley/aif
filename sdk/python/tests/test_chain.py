import json

import pytest

from rancher_ai import chain as ch
from rancher_ai import lineage as ln


def test_artifact_lines_are_read_from_a_log_the_last_one_winning():
    log = "\n".join([
        "INFO | step 10/10",
        'AIF_ARTIFACT {"direction":"input","name":"base-model","kind":"model","uri":"hf://Qwen/Qwen2.5-0.5B-Instruct@abc"}',
        'AIF_ARTIFACT {"direction":"output","name":"adapter","kind":"model","uri":"checkpoints://r1/adapter","sha256":"aa","bytes":5}',
        'AIF_ARTIFACT {"direction":"output","name":"adapter","kind":"model","uri":"checkpoints://r1/adapter","sha256":"bb","bytes":6}',
        'AIF_ARTIFACT {"direction":"sideways","name":"x","uri":"y"}',
        "AIF_ARTIFACT not json",
    ])
    arts = ln.parse_artifacts(log, run="r1", project="p")
    assert [(a.direction, a.name, a.sha256) for a in arts] == [("input", "base-model", ""), ("output", "adapter", "bb")]
    assert arts[1].run == "r1" and arts[1].kind == "model"


def test_a_checkpoints_uri_resolves_to_the_runs_volume():
    made = {"metadata": {"name": "dev-lora-train-abcde"}, "spec": {"values": {}}}
    given = {"metadata": {"name": "r2"}, "spec": {"values": {"storage": {"checkpointPVC": "team-vol"}}}}
    a = ln.resolve(ln.Artifact("adapter", "output", "checkpoints://dev-lora-train-abcde/adapter"), made)
    assert a.uri == "volume://dev-lora-train-abcde-checkpoints/dev-lora-train-abcde/adapter"
    assert a.volume_path == ("dev-lora-train-abcde-checkpoints", "dev-lora-train-abcde/adapter")
    assert ln.resolve(ln.Artifact("x", "output", "checkpoints://a/b"), given).uri == "volume://team-vol/a/b"
    assert ln.resolve(ln.Artifact("m", "input", "hf://q@1"), made).uri == "hf://q@1"


def test_kept_artifacts_come_back_from_the_aijob():
    arts = [{"name": "adapter", "direction": "output", "uri": "volume://v/a", "sha256": "cc"}]
    aj = {"metadata": {"name": "r", "namespace": "p", "annotations": {ln.ARTIFACTS_ANNOTATION: json.dumps(arts)}}}
    got = ln.stored(aj)
    assert got[0].name == "adapter" and got[0].run == "r" and got[0].project == "p"
    assert ln.stored({"metadata": {"name": "r"}}) is None


def test_a_folders_hash_is_its_files_not_where_it_is(tmp_path):
    for d in ("a", "b"):
        (tmp_path / d / "sub").mkdir(parents=True)
        (tmp_path / d / "w.bin").write_bytes(b"weights")
        (tmp_path / d / "sub" / "c.json").write_text("{}")
    assert ln.folder_sha256(str(tmp_path / "a")) == ln.folder_sha256(str(tmp_path / "b"))
    (tmp_path / "b" / "w.bin").write_bytes(b"other")
    assert ln.folder_sha256(str(tmp_path / "a")) != ln.folder_sha256(str(tmp_path / "b"))


def test_inputs_on_a_volume_are_mounted_and_handed_over_by_path():
    adapter = ln.Artifact("adapter", "output", "volume://r1-checkpoints/r1/adapter", sha256="aa", run="r1")
    data = ln.Artifact("dataset", "input", "hf-dataset://yahma/alpaca-cleaned@c0/alpaca.json", run="r1")
    f = ch.input_fields({"adapter": adapter, "dataset": data}, {"env": {"BATCH": "8"}})
    assert f["dataset"] == "r1-checkpoints"
    assert f["env"] == {"BATCH": "8", "AIF_INPUT_ADAPTER": "/mnt/dataset/r1/adapter",
                        "AIF_INPUT_DATASET": "hf-dataset://yahma/alpaca-cleaned@c0/alpaca.json"}
    with pytest.raises(ch.ChainError, match="one volume"):
        ch.input_fields({"a": adapter, "b": ln.Artifact("b", "output", "volume://other/x")}, {})
    with pytest.raises(ch.ChainError, match="dataset= names"):
        ch.input_fields({"a": adapter}, {"dataset": "mine"})


def test_a_step_is_the_same_step_by_profile_fields_and_input_content():
    a = ln.Artifact("adapter", "output", "volume://v1/x", sha256="aa")
    same_content_elsewhere = ln.Artifact("adapter", "output", "volume://v2/y", sha256="aa")
    h = ch.inputs_hash("shared-gpu-dev", {"script": "print(1)", "env": {"A": "1"}}, {"adapter": a})
    assert h == ch.inputs_hash("shared-gpu-dev", {"env": {"A": "1"}, "script": "print(1)"}, {"adapter": same_content_elsewhere})
    assert h != ch.inputs_hash("shared-gpu-dev", {"script": "print(2)", "env": {"A": "1"}}, {"adapter": a})
    assert h != ch.inputs_hash("shared-gpu-dev", {"script": "print(1)", "env": {"A": "1"}},
                               {"adapter": ln.Artifact("adapter", "output", "volume://v1/x", sha256="bb")})


def test_run_names_fit_and_keep_the_profiles_prefix():
    from rancher_ai.profiles import NAME_RE
    for prefix, c, s in (("dev", "suse-lora-v2", "train"), ("", "a-very-long-chain-name-for-tests", "evaluate-adapter"), ("dev", "x", "y")):
        n = ch.run_name(prefix, c, s, "ab12c")
        assert NAME_RE.match(n) and len(n) <= 42, n
        assert n.startswith(f"{prefix}-" if prefix else c[:4])
        assert n.endswith("ab12c")


class FakeCustom:
    def __init__(self, items):
        self.items = items


class FakeConn:
    def __init__(self, items):
        self.items = items

    def list_custom(self, group, version, plural, namespace=None, label_selector=None, required=False):
        want = dict(kv.split("=") for kv in label_selector.split(",") if "=" in kv)
        return [a for a in self.items if all((a["metadata"].get("labels") or {}).get(k) == v for k, v in want.items())]


class FakeClient:
    project = "p"

    def __init__(self, items):
        self.conn = FakeConn(items)


def aijob(name, step, phase, arts, metrics=None, parents="", h="h"):
    return {"metadata": {"name": name, "namespace": "p", "creationTimestamp": name,
                         "labels": {ch.CHAIN_LABEL: "c1", ch.STEP_LABEL: step},
                         "annotations": {ch.PARENTS_ANNOTATION: parents, ch.HASH_ANNOTATION: h,
                                         ln.ARTIFACTS_ANNOTATION: json.dumps(arts)}},
            "status": {"phase": phase, "startedAt": "2026-10-11T10:00:00Z", "completedAt": "2026-10-11T10:12:30Z",
                       "report": {"metrics": metrics or {}}}}


def test_the_chain_reads_back_its_steps_and_which_step_fed_which():
    jobs = [
        aijob("a-train", "train", "Succeeded",
              [{"name": "adapter", "direction": "output", "uri": "volume://a-train-checkpoints/a-train/adapter", "sha256": "aa"}],
              {"tokens_per_s": "812.5", "gpus": "1"}),
        aijob("b-eval", "eval", "Succeeded",
              [{"name": "adapter", "direction": "input", "uri": "file:///mnt/dataset/a-train/adapter", "sha256": "aa"}],
              {"adapter_loss": "1.21"}, parents="a-train"),
    ]
    c = ch.Chain(FakeClient(jobs), "c1")
    f = c.frame(as_frame=False)
    assert [r["step"] for r in f.rows] == ["train", "eval"]
    assert f.rows[0]["minutes"] == 12.5 and f.rows[0]["tokens_per_s"] == 812.5 and f.rows[0]["gpus"] == 1
    assert f.rows[1]["from"] == "a-train" and f.rows[0]["outputs"] == "adapter"
    lin = c.lineage(as_frame=False)
    eval_in = next(r for r in lin.rows if r["run"] == "b-eval")
    assert eval_in["produced_by"] == "a-train"


def test_names_a_chain_label_can_hold():
    with pytest.raises(ch.ChainError):
        ch.Chain(FakeClient([]), "Not_A_Label")
