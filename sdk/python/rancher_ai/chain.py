"""Chains: runs that feed each other (prepare data, train, evaluate), from a notebook, with lineage.

    chain = ai.chain("suse-lora-v2")
    train = chain.run("train", "shared-gpu-dev", script=train_py, env={...})
    evals = chain.run("eval", "shared-gpu-dev", script=eval_py, inputs={"adapter": train.output("adapter")})
    chain.frame()      # one row per step: state, times, metrics, what it consumed and produced
    chain.artifacts()  # one row per artifact, and which step produced what another consumed

A chain is labels on its runs' AIJobs (ai-factory.suse.com/chain and /step) and annotations (the
parent runs, the inputs, their hash), so it lives in the cluster, not the notebook: ai.chain(name)
picks it up again after a restart, and the AI Jobs view can find a run's chain.

An input on a volume is mounted for the step as its dataset volume (read-only, at /mnt/dataset) and
handed to the script as AIF_INPUT_<NAME>, the path to it; one volume per step. A step is keyed by
the values its run would install (the profile as resolved with its fields), the training chart's
version, a code ConfigMap's contents and its inputs by content. A step whose key matches a run that
already succeeded in the chain is not run again: run() returns that run (cache=False runs it anyway),
unless one of its outputs is gone. One that matches a run still under way waits for it, so a
notebook restarted mid-chain picks up where it was rather than starting the step twice. Carrying
on with no notebook at all is a workflow engine's job (Kubeflow Pipelines; see aif-lab).

A chain needs the AIJob API (AI Factory's operator), which keeps the runs' records and artifacts.
"""

from __future__ import annotations

import hashlib
import json
import re
import time
from typing import TYPE_CHECKING, Any

from . import lineage
from .display import Table
from .profiles import NAME_RE, ProfileError

if TYPE_CHECKING:
    from .client import Client
    from .workloads import TrainingRun

CHAIN_LABEL = "ai-factory.suse.com/chain"
STEP_LABEL = "ai-factory.suse.com/step"
PARENTS_ANNOTATION = "ai-factory.suse.com/parents"
INPUTS_ANNOTATION = "ai-factory.suse.com/inputs"
HASH_ANNOTATION = "ai-factory.suse.com/inputs-hash"
LABEL_VALUE = re.compile(r"^[a-z0-9]([-a-z0-9]{0,30}[a-z0-9])?$")
INPUT_MOUNT = "/mnt/dataset"


class ChainError(RuntimeError):
    pass


def inputs_hash(profile: str, values: dict, inputs: dict[str, lineage.Artifact], extra: dict | None = None) -> str:
    """What makes a step the same step: its profile, the values the run would install (the profile's
    as resolved with the step's fields, so its image, script, environment and seed all count, and a
    profile edited since changes the key), anything those values only name (extra: the training
    chart's version, a code ConfigMap's contents), and its inputs by content (their SHA-256, else
    where they are)."""
    doc = {"profile": profile, "values": values, "extra": extra or {},
           "inputs": {k: (a.sha256 or a.uri) for k, a in sorted(inputs.items())}}
    return hashlib.sha256(json.dumps(doc, sort_keys=True, default=str).encode()).hexdigest()


def input_fields(inputs: dict[str, lineage.Artifact], fields: dict) -> dict:
    """The fields that hand a step its inputs: the volume they are on, mounted as the dataset volume,
    and AIF_INPUT_<NAME> with each one's path there. Other inputs (a model id) pass as their URI."""
    out = dict(fields)
    env = dict(out.get("env") or {})
    vols = {a.volume_path[0] for a in inputs.values() if a.volume_path}
    if len(vols) > 1:
        raise ChainError(f"a step's inputs must be on one volume; these are on {', '.join(sorted(vols))}")
    if vols:
        vol = vols.pop()
        if out.get("dataset") and out["dataset"] != vol:
            raise ChainError(f"the inputs are on {vol}, but dataset= names {out['dataset']}; a step mounts one input volume")
        out["dataset"] = vol
    for k, a in inputs.items():
        vp = a.volume_path
        env[f"AIF_INPUT_{re.sub(r'[^A-Z0-9]', '_', k.upper())}"] = f"{INPUT_MOUNT}/{vp[1]}" if vp else a.uri
    if env:
        out["env"] = env
    return out


def run_name(prefix: str, chain: str, step: str, suffix: str) -> str:
    """<prefix->chain-step-suffix, within the 42 characters a run's name may have."""
    head = f"{prefix}-" if prefix else ""
    room = 42 - len(head) - len(suffix) - 2
    c, s = chain[: max(4, room - min(len(step), room // 2))].rstrip("-"), step[: room // 2 + 1].rstrip("-")
    return f"{head}{c}-{s}-{suffix}"[:42].rstrip("-")


class Chain:
    def __init__(self, client: "Client", name: str, project: str | None = None):
        if not LABEL_VALUE.match(name):
            raise ChainError(f"chain name {name!r}: lowercase letters, numbers and hyphens, at most 32")
        self.c, self.name, self.project = client, name, project or client.project

    def __repr__(self) -> str:
        return f"<Chain {self.name!r} project={self.project!r} steps={len(self.aijobs())}>"

    # ---- running a step
    def run(self, step: str, profile: str, inputs: dict[str, Any] | None = None, cache: bool = True,
            wait: bool = True, timeout: float = 6 * 3600, quiet: bool = False, **fields: Any) -> "TrainingRun":
        """Run one step of the chain from a training profile, with the profile's fields (script, env,
        image, ...). inputs maps a name to an Artifact (another step's run.output(name)), or to a URI.
        Waits for the run to finish unless wait=False, and keeps its artifacts on its record."""
        if not LABEL_VALUE.match(step):
            raise ChainError(f"step name {step!r}: lowercase letters, numbers and hyphens, at most 32")
        from .install import AIJobInstaller
        if not isinstance(self.c.installer, AIJobInstaller):
            raise ChainError("a chain needs the AIJob API (AI Factory's operator) on the cluster")
        arts = {k: (v if isinstance(v, lineage.Artifact) else lineage.Artifact(name=k, direction="input", uri=str(v)))
                for k, v in (inputs or {}).items()}
        step_fields = input_fields(arts, fields)
        # the key: the values the run would install, as runs.create resolves them, and what they name
        values = self.c.runs.create(profile, project=self.project, dry_run=True, **step_fields)
        h = inputs_hash(profile, values, arts, self._named(values))
        say = (lambda *a: None) if quiet else print
        # an identical step already under way is waited on, not started again (a notebook restarted mid-chain)
        r = self._in_flight(step, h)
        if r is not None:
            say(f"{step}: {r.name} is already {r.state.lower()} with the same inputs; waiting for it")
            r.cached = False
        elif cache and (hit := self._cached(step, h)) is not None:
            say(f"{step}: unchanged since {hit.name}, which succeeded; using it (cache=False runs it again)")
            hit.cached = True
            return hit
        else:
            p = self.c.profiles.get(profile)
            from .client import _suffix
            name = run_name(p.name_prefix, self.name, step, _suffix())
            if not NAME_RE.match(name):
                raise ChainError(f"cannot make a valid run name from chain {self.name!r} and step {step!r}")
            parents = sorted({a.run for a in arts.values() if a.run})
            meta = {"labels": {CHAIN_LABEL: self.name, STEP_LABEL: step},
                    "annotations": {HASH_ANNOTATION: h, PARENTS_ANNOTATION: ",".join(parents),
                                    INPUTS_ANNOTATION: json.dumps({k: a.to_dict() for k, a in arts.items()}, separators=(",", ":"))}}
            r = self.c.runs.create(profile, project=self.project, name=name, metadata=meta, **step_fields)
            r.cached = False
            say(f"{step}: started {r.name}" + (f" from {', '.join(parents)}" if parents else ""))
        if not wait:
            return r
        state = r.wait(timeout=timeout)
        aj = self._aijob(r.name)
        if state != "Completed":
            res = (aj.get("status") or {}).get("result") or {}
            raise ChainError(f"{step}: {r.name} {state.lower()}" + (f": {res.get('reason', '')} {res.get('message', '')}".rstrip() if res else ""))
        # the step reports its inputs where it saw them (a path in its pod); the record keeps where they are
        local = {f"file://{INPUT_MOUNT}/{a.volume_path[1]}": a.uri for a in arts.values() if a.volume_path}
        outs = [a for a in lineage.artifacts_of(self.c, r.name, self.project, finished=True, portable=local) if a.direction == "output"]
        say(f"{step}: {r.name} succeeded" + (f"; outputs: {', '.join(a.name for a in outs)}" if outs else ""))
        return r

    def _named(self, values: dict) -> dict:
        """What the values only name, by content: the training chart version, and a code ConfigMap."""
        from . import install
        extra = {}
        try:
            extra["chart"] = install.chart_version(self.c.conn)
        except Exception:
            pass
        cm = (values.get("storage") or {}).get("configMap")
        if cm:
            try:
                obj = self.c.conn.core.read_namespaced_config_map(cm, self.project)
                extra["configMap"] = hashlib.sha256(json.dumps([obj.data or {}, obj.binary_data or {}], sort_keys=True).encode()).hexdigest()
            except Exception:
                extra["configMap"] = cm
        return extra

    def _in_flight(self, step: str, h: str) -> "TrainingRun | None":
        for aj in reversed(self.aijobs(step)):
            if (aj["metadata"].get("annotations") or {}).get(HASH_ANNOTATION) == h and \
                    (aj.get("status") or {}).get("phase", "Pending") in ("Pending", "Queued", "Admitted", "Running"):
                return self.c.runs.get(aj["metadata"]["name"], self.project)
        return None

    def _cached(self, step: str, h: str) -> "TrainingRun | None":
        for aj in reversed(self.aijobs(step)):
            md = aj["metadata"]
            if (md.get("annotations") or {}).get(HASH_ANNOTATION) != h or (aj.get("status") or {}).get("phase") != "Succeeded":
                continue
            outs = [a for a in (lineage.stored(aj) or []) if a.direction == "output" and a.volume_path]
            # its outputs must still be there: the volume, and the path on it
            if any(not self._volume_exists(a.volume_path[0]) for a in outs):
                continue
            if any(not self.c.volumes.exists(*a.volume_path, project=self.project) for a in outs):
                continue
            return self.c.runs.get(md["name"], self.project)
        return None

    def _volume_exists(self, name: str) -> bool:
        try:
            self.c.conn.core.read_namespaced_persistent_volume_claim(name, self.project)
            return True
        except Exception:
            return False

    def _aijob(self, name: str) -> dict:
        return self.c.conn.custom.get_namespaced_custom_object(*lineage.AIJOB[:2], self.project, lineage.AIJOB[2], name)

    # ---- reading the chain back
    def aijobs(self, step: str | None = None) -> list[dict]:
        sel = f"{CHAIN_LABEL}={self.name}" + (f",{STEP_LABEL}={step}" if step else "")
        items = self.c.conn.list_custom(*lineage.AIJOB[:2], lineage.AIJOB[2], self.project, label_selector=sel)
        return sorted(items, key=lambda a: a["metadata"].get("creationTimestamp", ""))

    def frame(self, as_frame: bool | None = None):
        """One row per run in the chain: its step, state, times, the runs it consumed, what it
        produced, and its metrics (one column each)."""
        rows = []
        for aj in self.aijobs():
            md, st = aj["metadata"], aj.get("status") or {}
            arts = lineage.stored(aj) or []
            row = {"step": (md.get("labels") or {}).get(STEP_LABEL, ""), "run": md["name"], "state": st.get("phase", "Pending"),
                   "started": st.get("startedAt", ""), "finished": st.get("completedAt", ""),
                   "minutes": _minutes(st.get("startedAt"), st.get("completedAt")),
                   "from": (md.get("annotations") or {}).get(PARENTS_ANNOTATION, ""),
                   "outputs": ", ".join(a.name for a in arts if a.direction == "output"),
                   "inputs_hash": (md.get("annotations") or {}).get(HASH_ANNOTATION, "")[:12]}
            for k, v in ((st.get("report") or {}).get("metrics") or {}).items():
                row[k] = _number(v)
            rows.append(row)
        cols = list(dict.fromkeys(k for r in rows for k in r)) or ["step", "run", "state"]
        return _table(rows, cols, as_frame)

    def artifacts(self, as_frame: bool | None = None):
        """One row per artifact a run in the chain reported: which step consumed or produced it, its
        content hash, and for an input the run in the chain that produced it (matched by content)."""
        rows, made = [], {}
        jobs = self.aijobs()
        for aj in jobs:
            for a in lineage.stored(aj) or []:
                if a.direction == "output" and a.sha256:
                    made.setdefault(a.sha256, a.run)
        for aj in jobs:
            step = (aj["metadata"].get("labels") or {}).get(STEP_LABEL, "")
            for a in lineage.stored(aj) or []:
                rows.append({"step": step, "run": a.run, "direction": a.direction, "name": a.name, "kind": a.kind, "uri": a.uri,
                             "sha256": a.sha256[:12], "produced_by": made.get(a.sha256, "") if a.direction == "input" else ""})
        return _table(rows, ["step", "run", "direction", "name", "kind", "uri", "sha256", "produced_by"], as_frame)


class Chains:
    def __init__(self, c: "Client"):
        self.c = c

    def __call__(self, name: str, project: str | None = None) -> Chain:
        return Chain(self.c, name, project)

    def list(self, project: str | None = None) -> list[str]:
        """The chains with runs in the project."""
        items = self.c.conn.list_custom(*lineage.AIJOB[:2], lineage.AIJOB[2], project or self.c.project, label_selector=CHAIN_LABEL)
        return sorted({(a["metadata"].get("labels") or {}).get(CHAIN_LABEL, "") for a in items} - {""})


def _minutes(a: str | None, b: str | None) -> float | None:
    if not a or not b:
        return None
    from datetime import datetime
    f = lambda s: datetime.fromisoformat(s.replace("Z", "+00:00"))
    return round((f(b) - f(a)).total_seconds() / 60, 1)


def _number(v: Any) -> Any:
    try:
        return int(v)
    except (TypeError, ValueError):
        try:
            return float(v)
        except (TypeError, ValueError):
            return v


def _table(rows: list[dict], cols: list[str], as_frame: bool | None):
    t = Table(rows, cols)
    if as_frame is not False:
        try:
            return t.to_pandas()
        except ImportError:
            if as_frame:
                raise
    return t


__all__ = ["Chain", "Chains", "ChainError", "ProfileError", "inputs_hash", "input_fields", "run_name"]
