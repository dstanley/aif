"""Only a run's own checkpoint volume is managed: the chart's labels and the <run>-checkpoints name."""

from types import SimpleNamespace as NS

from rancher_ai.checkpoints import _run_of


def pvc(name, labels):
    return NS(metadata=NS(name=name, labels=labels))


def test_a_runs_checkpoint_volume_is_recognised():
    assert _run_of(pvc("dev-1-checkpoints", {"app.kubernetes.io/name": "gpu-train-job", "app.kubernetes.io/instance": "dev-1"})) == "dev-1"


def test_datasets_scratch_and_lookalikes_are_not():
    chart = {"app.kubernetes.io/name": "gpu-train-job", "app.kubernetes.io/instance": "dev-1"}
    assert _run_of(pvc("dolly", {})) == ""
    assert _run_of(pvc("dev-1-0-abcde-scratch", chart)) == ""
    assert _run_of(pvc("other-checkpoints", chart)) == ""
    assert _run_of(pvc("dev-1-checkpoints", {"app.kubernetes.io/instance": "dev-1"})) == ""
