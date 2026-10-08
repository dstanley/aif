from rancher_ai.fit import fit, needs_of, node_facts, parse_requires


def node(name, labels, gpus):
    return {"metadata": {"name": name, "labels": labels}, "status": {"allocatable": {"nvidia.com/gpu": str(gpus)}}}


# as the lab's GPU node reports itself, and a GB200
A2000 = node("rke2-worker1", {"kubernetes.io/arch": "amd64", "nvidia.com/gpu.memory": "12282", "nvidia.com/gpu.compute.major": "8",
                              "nvidia.com/gpu.compute.minor": "6", "nvidia.com/cuda.driver-version.major": "580"}, 1)
GB200 = node("gb200", {"kubernetes.io/arch": "arm64", "nvidia.com/gpu.memory": "189471", "nvidia.com/gpu.compute.major": "10",
                       "nvidia.com/gpu.compute.minor": "0", "nvidia.com/cuda.driver-version.major": "580"}, 2)
CPU = node("cpu-1", {"kubernetes.io/arch": "amd64"}, 0)
LAB, GB = node_facts([A2000, CPU]), node_facts([GB200])


def test_requires_parses_and_flags_what_it_cannot_hold():
    problems = []
    assert parse_requires({"gpuMemoryGiB": 70, "computeCapability": "9.0", "arch": "arm64"}, problems) == \
        {"gpuMemoryGiB": 70, "computeCapability": "9.0", "arch": ["arm64"]}
    parse_requires({"vram": 12, "computeCapability": "hopper", "driver": "new"}, problems)
    assert len(problems) == 3


def test_a_70_gb_model_fits_a_gb200_not_an_a2000_with_the_ui_s_words():
    big = needs_of("training", {}, {"gpuMemoryGiB": 70, "computeCapability": "9.0"})
    assert fit(big, GB) == (True, [])
    ok, why = fit(big, LAB)
    assert not ok and why == ["it needs 70 GiB of GPU memory, compute capability 9.0; this cluster's best is 12 GiB GPUs, compute capability 8.6, driver 580"]


def test_architecture_cpu_profiles_shares_and_gpus_per_node():
    assert "built for amd64" in fit(needs_of("training", {}, {"arch": ["amd64"]}), GB)[1][0]
    assert fit(needs_of("training", {"gpu": {"mode": "none"}}, {}), node_facts([CPU]))[0]
    assert fit(needs_of("training", {}, {}), node_facts([CPU]))[1] == ["it needs a GPU, and this cluster has none"]
    share = needs_of("training", {"gpu": {"sharedMemoryMiB": 4096}}, {})
    assert fit(share, LAB, True)[0] and not fit(share, LAB, False)[0]
    assert fit(needs_of("training", {"job": {"gpusPerNode": 2}}, {}), GB)[0]
    assert not fit(needs_of("training", {"job": {"gpusPerNode": 2}}, {}), LAB)[0]


def test_an_unreported_fact_does_not_rule_a_profile_out():
    assert fit(needs_of("training", {}, {"gpuMemoryGiB": 70, "driver": 580}), node_facts([node("n", {}, 1)]))[0]


def test_several_workers_need_a_gpu_each_in_all():
    two = needs_of("training", {"job": {"nodes": 2}}, {}, min_workers=2)
    assert fit(two, LAB)[1] == ["it needs 2 GPUs in all (one per worker at least); this cluster has 1"]
    assert fit(two, GB)[0]
