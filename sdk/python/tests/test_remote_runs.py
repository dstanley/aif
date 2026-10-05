import pytest

from rancher_ai import install


def test_a_remote_run_names_its_cluster_in_the_aijob():
    job = install.aijob_for("aif-submit", "r1", {"job": {}}, "cpu-inference-test", "2.3.0", cluster="c-npk9v")
    assert job["spec"]["targetCluster"] == "c-npk9v"
    assert "targetCluster" not in install.aijob_for("aif-submit", "r1", {}, "p", "2.3.0")["spec"]
    assert "targetCluster" not in install.aijob_for("aif-submit", "r1", {}, "p", "2.3.0", cluster="local")["spec"]


def test_a_remote_run_does_not_take_this_clusters_scheduler():
    v = install.complete_remote({"gpu": {"mode": "none"}}, "cpu-inference-test", "c-npk9v")
    assert v["scheduler"] == {"type": "none", "queue": ""}
    assert v["preflight"]["checkHeadroom"] is False and v["profile"] == "cpu-inference-test"
    kept = install.complete_remote({"scheduler": {"type": "kai", "queue": "q"}}, "p", "c-npk9v")
    assert kept["scheduler"] == {"type": "kai", "queue": "q"}


def test_a_shared_gpu_on_another_cluster_needs_the_profile_to_name_its_scheduler():
    with pytest.raises(RuntimeError, match="GPU-sharing scheduler"):
        install.complete_remote({"gpu": {"sharedMemoryMiB": 4096}}, "p", "c-npk9v")


def test_a_remote_runs_logs_are_not_read_here():
    from rancher_ai.workloads import TrainingRun
    r = TrainingRun(client=None, name="r1", namespace="aif-submit", cluster="c-npk9v")
    with pytest.raises(RuntimeError, match="runs on cluster c-npk9v"):
        r.logs(print_=False)
    assert r.result() is None


class _Conn:
    def __init__(self, clusters):
        self.clusters = clusters

    def list_custom(self, group, version, plural, namespace=None, **kw):
        assert (group, plural) == ("management.cattle.io", "clusters")
        return [{"metadata": {"name": i}, "spec": {"displayName": n}} for i, n in self.clusters]


def _client(clusters):
    from types import SimpleNamespace
    return SimpleNamespace(conn=_Conn(clusters), _cluster_names=None)


def test_a_cluster_is_named_by_its_name_or_its_id():
    from rancher_ai.client import _cluster_id
    c = _client([("local", "local"), ("c-npk9v", "harv"), ("c-djjjc", "marv")])
    assert _cluster_id(c, "harv") == "c-npk9v"
    assert _cluster_id(c, "c-djjjc") == "c-djjjc"
    assert _cluster_id(c, "local") == "local"


def test_a_name_two_clusters_have_needs_the_id():
    from rancher_ai.client import _cluster_id
    from rancher_ai.profiles import ProfileError
    c = _client([("c-aaa11", "gpu"), ("c-bbb22", "gpu")])
    with pytest.raises(ProfileError, match="more than one cluster is named 'gpu'"):
        _cluster_id(c, "gpu")


def test_an_unknown_cluster_lists_the_ones_there_are():
    from rancher_ai.client import _cluster_id
    from rancher_ai.profiles import ProfileError
    with pytest.raises(ProfileError, match=r"clusters: harv \(c-npk9v\)"):
        _cluster_id(_client([("c-npk9v", "harv")]), "nope")


def test_an_id_is_taken_as_it_is_when_clusters_cannot_be_listed():
    from rancher_ai.client import _cluster_id
    assert _cluster_id(_client([]), "c-npk9v") == "c-npk9v"


def test_a_remote_run_shows_its_cluster_by_name():
    from rancher_ai.workloads import TrainingRun, _cluster_label
    assert _cluster_label(TrainingRun(client=None, name="r", namespace="p", cluster="c-npk9v", cluster_name="harv")) == "harv (c-npk9v)"
    assert _cluster_label(TrainingRun(client=None, name="r", namespace="p")) == "local"
