"""Whether a cluster can run a profile, and if not, why: the same rules as the UI's Catalog and Submit
page (ui/pkg/aif-ui/training/fit.ts). A profile's `requires` (GPU memory, GPUs per node, GPU nodes,
compute capability, driver, CPU architecture) and what its values imply (a GPU at all, a GPU-memory
share) against what the nodes report (GPU Feature Discovery's labels, the allocatable GPUs).

A fact a node does not report is unknown, and an unknown never rules a profile out."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

KEYS = ("gpuMemoryGiB", "gpusPerNode", "nodes", "computeCapability", "driver", "arch")


def parse_requires(raw: Any, problems: list[str]) -> dict:
    """A profile's `requires`, with a problem for anything that is not one of its keys or has the wrong type."""
    if raw is None:
        return {}
    if not isinstance(raw, dict):
        problems.append("requires must be a mapping")
        return {}
    out: dict = {}
    for k, v in raw.items():
        if k not in KEYS:
            problems.append(f"requires.{k} is not something a profile can require ({', '.join(KEYS)})")
        elif k == "arch":
            out["arch"] = [str(a) for a in (v if isinstance(v, list) else [v]) if a]
        elif k == "computeCapability":
            if not re.match(r"^\d+(\.\d+)?$", str(v)):
                problems.append(f'requires.computeCapability "{v}" must be major.minor, e.g. 9.0')
            else:
                out["computeCapability"] = str(v)
        else:
            try:
                n = float(v)
                if n < 0:
                    raise ValueError
                out[k] = n
            except (TypeError, ValueError):
                problems.append(f"requires.{k} must be a number")
    return out


@dataclass
class NodeFacts:
    name: str
    arch: str = ""
    gpus: int = 0
    gpu_memory_mib: int | None = None
    compute_capability: tuple[int, int] | None = None
    driver: int | None = None


def _num(s: Any) -> int | None:
    try:
        return int(s) if s not in (None, "") else None
    except (TypeError, ValueError):
        return None


def node_facts(nodes: list) -> list[NodeFacts]:
    """What each node reports about itself (kubernetes client V1Node objects or dicts)."""
    out = []
    for n in nodes or []:
        md = n.metadata if hasattr(n, "metadata") else None
        labels = ((md.labels if md else n.get("metadata", {}).get("labels")) or {})
        alloc = ((n.status.allocatable if hasattr(n, "status") else n.get("status", {}).get("allocatable")) or {})
        major = _num(labels.get("nvidia.com/gpu.compute.major"))
        out.append(NodeFacts(
            name=(md.name if md else n.get("metadata", {}).get("name", "")),
            arch=labels.get("kubernetes.io/arch", ""),
            gpus=_num(alloc.get("nvidia.com/gpu")) or 0,
            gpu_memory_mib=_num(labels.get("nvidia.com/gpu.memory")),
            compute_capability=None if major is None else (major, _num(labels.get("nvidia.com/gpu.compute.minor")) or 0),
            driver=_num(labels.get("nvidia.com/cuda.driver-version.major", labels.get("nvidia.com/cuda.driver.major"))),
        ))
    return out


@dataclass
class Needs:
    gpu: bool
    requires: dict = field(default_factory=dict)
    share_mib: int = 0
    total_gpus: int = 0  # whole GPUs the run needs in all: its workers, each with its GPUs


def needs_of(profile_type: str, values: dict, requires: dict, min_workers: int | None = None) -> Needs:
    """What a run needs: the profile's requires, and what its chart values imply."""
    gpu_mode = (values.get("gpu") or {}).get("mode", "auto")
    gpu = profile_type == "inference" or gpu_mode != "none"
    share = int((values.get("gpu") or {}).get("sharedMemoryMiB") or 0)
    r = dict(requires or {})
    per_node = int((values.get("job") or {}).get("gpusPerNode") or 0)
    if gpu and per_node > 1 and not share:
        r["gpusPerNode"] = max(r.get("gpusPerNode") or 0, per_node)
    workers = int(min_workers or (values.get("job") or {}).get("nodes") or 1)
    return Needs(gpu=gpu, requires=r, share_mib=share, total_gpus=workers * max(1, per_node) if gpu and not share else 0)


def _gib(mib: float) -> str:
    return f"{round(mib / 1024)} GiB"


def _cc(s: str) -> tuple[int, int]:
    a, _, b = s.partition(".")
    return int(a or 0), int(b or 0)


def fit(needs: Needs, facts: list[NodeFacts], sharing: bool | None = None) -> tuple[bool, list[str]]:
    """(fits, reasons): whether the nodes can run it, and why not, in words."""
    r, reasons = needs.requires, []
    arch = r.get("arch") or []
    if arch and facts and all(f.arch and f.arch not in arch for f in facts):
        reasons.append(f"its images are built for {' or '.join(arch)}; this cluster's nodes are {', '.join(sorted({f.arch for f in facts}))}")
    if not needs.gpu:
        return not reasons, reasons
    gpu_nodes = [f for f in facts if f.gpus > 0]
    if not gpu_nodes:
        return False, reasons + ["it needs a GPU, and this cluster has none"]
    if needs.share_mib and sharing is False:
        reasons.append("it runs on a share of a GPU, which needs KAI GPU sharing, not installed here")
    want_mib = max((r.get("gpuMemoryGiB") or 0) * 1024, needs.share_mib)
    want_cc = _cc(r["computeCapability"]) if r.get("computeCapability") else None

    def why(f: NodeFacts) -> list[str]:
        out = []
        if r.get("gpusPerNode") and f.gpus < r["gpusPerNode"]:
            out.append(f"{int(r['gpusPerNode'])} GPUs on one node")
        if want_mib and f.gpu_memory_mib is not None and f.gpu_memory_mib < want_mib:
            out.append(f"{_gib(want_mib)} of GPU memory")
        if want_cc and f.compute_capability and f.compute_capability < want_cc:
            out.append(f"compute capability {want_cc[0]}.{want_cc[1]}")
        if r.get("driver") and f.driver is not None and f.driver < r["driver"]:
            out.append(f"NVIDIA driver {int(r['driver'])} or newer")
        if arch and f.arch and f.arch not in arch:
            out.append(" or ".join(arch))
        return out

    able = [f for f in gpu_nodes if not why(f)]
    wanted = int(r.get("nodes") or 1)
    total = sum(f.gpus for f in able)
    if needs.total_gpus > 1 and len(able) >= wanted and total < needs.total_gpus:
        reasons.append(f"it needs {needs.total_gpus} GPUs in all (one per worker at least); this cluster has {total}")
    if len(able) < wanted:
        best = min(gpu_nodes, key=lambda f: len(why(f)))
        lack = why(best)
        has = ", ".join(x for x in (
            f"{_gib(best.gpu_memory_mib)} GPUs" if best.gpu_memory_mib is not None else "",
            f"{best.gpus} per node" if best.gpus > 1 else "",
            f"compute capability {best.compute_capability[0]}.{best.compute_capability[1]}" if best.compute_capability else "",
            f"driver {best.driver}" if best.driver is not None else "",
        ) if x)
        if lack:
            reasons.append(f"it needs {', '.join(lack)}; this cluster's best is {has or 'unknown'}")
        if wanted > 1:
            reasons.append(f"it needs {wanted} GPU nodes that meet its needs; this cluster has {len(able)}")
    return not reasons, reasons
