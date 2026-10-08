#!/usr/bin/env python3
"""Build the core test profiles in ../profiles from the scripts in this directory, so a profile
always carries its script's current text. Run after changing a script:

  python3 examples/training/tests/build_profiles.py

These are AI Factory's hardware-neutral checks (PyTorch GPU Test, CPU Smoke Test). Tests and
benchmarks tuned to particular hardware live in profile packs, each a Helm chart of profiles, such
as those in https://github.com/dstanley/aif-lab/tree/main/profile-packs.
"""
import os

import yaml

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "profiles")
TORCH = {"repository": "dp.apps.rancher.io/containers/pytorch", "tag": "2.14.0-nvidia-2.1"}
PULL = [{"name": "suse-ai-pull-combined"}]
ENV = [{"name": "PYTHONUNBUFFERED", "value": "1"}]


def script(name):
    with open(os.path.join(HERE, name)) as f:
        return f.read()


def torchrun(name, nodes, requests, **extra):
    v = {"image": TORCH, "imagePullSecrets": PULL, "job": {"kind": "job", "mode": "torchrun", "nodes": nodes, "gpusPerNode": 1, "script": script(name)},
         "resources": {"requests": requests}, "env": ENV}
    v.update(extra)
    return v


SMALL = {"cpu": "1", "memory": "4Gi", "ephemeral-storage": "2Gi"}

# CPU only, with PyTorch in the image: torchrun on CPUs (Gloo), no GPU, no pull secret.
TORCH_CPU = {"repository": "pytorch/pytorch", "tag": "2.5.1-cuda12.4-cudnn9-runtime"}

PROFILES = [
    ("31-pytorch-gpu-test", "pytorch-gpu-test", {
        "displayName": "PyTorch GPU Test", "purpose": "test", "framework": "PyTorch", "status": "ready",
        "description": "About a minute on one whole GPU: PyTorch sees CUDA and the GPU, allocates memory, multiplies matrices in FP32, FP16 and BF16, and trains a few steps. Reports versions and TFLOPS.",
        "values": torchrun("pytorch_gpu_test.py", 1, SMALL), "editable": ["image", "tag"],
        # the Application Collection image's CUDA 13 needs driver 580+; it is built for amd64 and arm64
        "requires": {"driver": 580, "arch": ["amd64", "arm64"]},
        "limits": {"nodes": {"min": 1, "max": 1}, "registries": ["dp.apps.rancher.io/containers/", "nvcr.io/nvidia/", "pytorch/"], "maxRuntimeHours": 1}}),
    ("41-cpu-smoke-test", "cpu-smoke-test", {
        "displayName": "CPU Smoke Test", "purpose": "test", "framework": "PyTorch (CPU)", "status": "ready",
        "description": "About a minute on CPUs alone, no GPU: PyTorch, the CPUs and memory the pod is given, a matrix multiply, a training step, a Gloo collective and file I/O. Checks that a cluster can run a PyTorch job on CPUs.",
        "values": {"image": TORCH_CPU, "gpu": {"mode": "none"},
                   "job": {"kind": "job", "mode": "torchrun", "nodes": 1, "gpusPerNode": 1, "script": script("cpu_smoke_test.py")},
                   "rendezvous": {"backend": "c10d"},
                   "resources": {"requests": {"cpu": "2", "memory": "2Gi", "ephemeral-storage": "1Gi"}}, "env": ENV},
        "editable": ["nodes"], "limits": {"nodes": {"min": 1, "max": 2}, "maxRuntimeHours": 1},
        # pytorch/pytorch is built for amd64 only
        "requires": {"arch": ["amd64"]}}),
]

class Literal(str):
    pass


yaml.add_representer(Literal, lambda d, s: d.represent_scalar("tag:yaml.org,2002:str", s, style="|"))


def literal_scripts(o):
    if isinstance(o, dict):
        return {k: (Literal(v) if isinstance(v, str) and "\n" in v else literal_scripts(v)) for k, v in o.items()}
    if isinstance(o, list):
        return [Literal(v) if isinstance(v, str) and "\n" in v else literal_scripts(v) for v in o]
    return o


for fname, name, doc in PROFILES:
    body = yaml.dump(literal_scripts(doc), sort_keys=False, width=1000, allow_unicode=True)
    cm = {"apiVersion": "v1", "kind": "ConfigMap",
          "metadata": {"name": name, "namespace": "ai-profiles", "labels": {"trainingjobs/profile": "training"}},
          "data": {"profile.yaml": Literal(body)}}
    with open(os.path.join(OUT, f"{fname}.yaml"), "w") as f:
        f.write(f"# {doc['displayName']}: {doc['description']}\n# Built by ../tests/build_profiles.py from ../tests/; edit the script there and rebuild.\n")
        yaml.dump(cm, f, sort_keys=False, width=1000, allow_unicode=True)
    print("wrote", fname)
