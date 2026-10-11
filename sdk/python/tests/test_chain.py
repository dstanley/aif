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


def test_a_step_is_the_same_step_by_its_values_what_they_name_and_input_content():
    a = ln.Artifact("adapter", "output", "volume://v1/x", sha256="aa")
    same_content_elsewhere = ln.Artifact("adapter", "output", "volume://v2/y", sha256="aa")
    values = {"image": {"repository": "dp.apps.rancher.io/containers/pytorch", "tag": "2.14.0-nvidia-2.1"},
              "job": {"script": "print(1)"}, "env": [{"name": "SEED", "value": "1"}]}
    extra = {"chart": "2.3.0-training.12"}
    h = ch.inputs_hash("shared-gpu-dev", values, {"adapter": a}, extra)
    assert h == ch.inputs_hash("shared-gpu-dev", dict(reversed(list(values.items()))), {"adapter": same_content_elsewhere}, extra)
    # a profile edited to a new image, a new seed, a new chart, new input content: each a new step
    for v, e, i in (({**values, "image": {"repository": "dp.apps.rancher.io/containers/pytorch", "tag": "2.15.0"}}, extra, a),
                    ({**values, "env": [{"name": "SEED", "value": "2"}]}, extra, a),
                    (values, {"chart": "2.3.0-training.13"}, a),
                    (values, extra, ln.Artifact("adapter", "output", "volume://v1/x", sha256="bb"))):
        assert h != ch.inputs_hash("shared-gpu-dev", v, {"adapter": i}, e)


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
    lin = c.artifacts(as_frame=False)
    eval_in = next(r for r in lin.rows if r["run"] == "b-eval")
    assert eval_in["produced_by"] == "a-train"


def test_names_a_chain_label_can_hold():
    with pytest.raises(ch.ChainError):
        ch.Chain(FakeClient([]), "Not_A_Label")


class FakeRuns:
    def __init__(self):
        self.got = []

    def get(self, name, project=None):
        self.got.append(name)
        from types import SimpleNamespace
        return SimpleNamespace(name=name, state="Running")


class FakeVolumes:
    def __init__(self, present):
        self.present = present

    def exists(self, volume, path, project=None):
        return (volume, path) in self.present


class FakeChainClient(FakeClient):
    def __init__(self, items, present=()):
        super().__init__(items)
        self.runs, self.volumes = FakeRuns(), FakeVolumes(set(present))
        self.conn.core = self

    def read_namespaced_persistent_volume_claim(self, name, ns):
        return name


def test_a_step_under_way_is_waited_on_and_a_cached_one_needs_its_outputs_there():
    out = [{"name": "adapter", "direction": "output", "uri": "volume://t1-checkpoints/t1/adapter", "sha256": "aa"}]
    running = aijob("t2-train", "train", "Running", [], h="h1")
    done = aijob("t1-train", "train", "Succeeded", out, h="h1")
    c = ch.Chain(FakeChainClient([done, running]), "c1")
    assert c._in_flight("train", "h1").name == "t2-train"
    assert c._in_flight("train", "other") is None
    c = ch.Chain(FakeChainClient([done], present=[("t1-checkpoints", "t1/adapter")]), "c1")
    assert c._cached("train", "h1").name == "t1-train"
    c = ch.Chain(FakeChainClient([done], present=[]), "c1")
    assert c._cached("train", "h1") is None  # the volume is there, the adapter on it is not


def test_a_consumers_inputs_are_recorded_where_they_are():
    from types import SimpleNamespace
    log = "\n".join([
        'AIF_ARTIFACT {"direction":"input","name":"adapter","kind":"model","uri":"file:///mnt/dataset/t1/adapter/","sha256":"aa"}',
        'AIF_ARTIFACT {"direction":"input","name":"dataset","kind":"dataset","uri":"hf-dataset://yahma/alpaca-cleaned@c0/a.json"}',
    ])
    patched = []

    class Custom:
        def get_namespaced_custom_object(self, *a):
            return {"metadata": {"name": "e1", "namespace": "p"}, "spec": {"values": {}}, "status": {"phase": "Running"}}

        def patch_namespaced_custom_object(self, *a):
            patched.append(a[-1])

    c = SimpleNamespace(conn=SimpleNamespace(custom=Custom()),
                        runs=SimpleNamespace(get=lambda n, p: SimpleNamespace(logs=lambda **k: log)))
    arts = ln.artifacts_of(c, "e1", "p", finished=True,
                           portable={"file:///mnt/dataset/t1/adapter": "volume://t1-checkpoints/t1/adapter"})
    assert [a.uri for a in arts] == ["volume://t1-checkpoints/t1/adapter", "hf-dataset://yahma/alpaca-cleaned@c0/a.json"]
    kept = json.loads(patched[0]["metadata"]["annotations"][ln.ARTIFACTS_ANNOTATION])
    assert kept[0]["uri"] == "volume://t1-checkpoints/t1/adapter" and kept[0]["sha256"] == "aa"
