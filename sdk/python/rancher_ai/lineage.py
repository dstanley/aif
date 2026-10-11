"""What a run consumed and produced: its artifacts, for lineage from data to model.

A run reports its artifacts the way it reports its result: one line per artifact in its first
worker's log,

    AIF_ARTIFACT {"direction": "output", "name": "adapter", "kind": "model",
                  "uri": "checkpoints://<run>/adapter", "sha256": "...", "bytes": 1090519040}

direction is input or output; uri names where it lives:

    checkpoints://<path>          a path on the run's own checkpoint volume (the SDK resolves which)
    volume://<pvc>/<path>         a path on a volume in the project
    hf://<repo>@<revision>        a Hugging Face model at a commit
    hf-dataset://<repo>@<revision>/<file>
    file://<path>                 a path inside the run's pods (a mounted ConfigMap, say)

sha256 identifies the content (for a folder: of its files' paths and hashes, see folder_sha256), so
a later run that consumed it can be matched to the run that produced it, whatever the names.

Logs go with the pods, so the SDK keeps a finished run's artifacts on its AIJob (the
ai-factory.suse.com/artifacts annotation, written by capture()); from then on they outlive the run's
pods and Job, like its result.
"""

from __future__ import annotations

import hashlib
import json
import os
from dataclasses import asdict, dataclass
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from .client import Client

ARTIFACT_MARKER = "AIF_ARTIFACT "
AIJOB = ("ai-factory.suse.com", "v1alpha1", "aijobs")
ARTIFACTS_ANNOTATION = "ai-factory.suse.com/artifacts"
KINDS = ("model", "dataset", "metrics", "code", "other")


@dataclass
class Artifact:
    name: str
    direction: str  # input | output
    uri: str
    kind: str = "other"
    sha256: str = ""
    bytes: int = 0
    run: str = ""  # the run that reported it
    project: str = ""

    @property
    def volume_path(self) -> tuple[str, str] | None:
        """(volume, path on it) for an artifact on a volume, else None. A checkpoints:// path is
        resolved by resolve() first."""
        if self.uri.startswith("volume://"):
            vol, _, path = self.uri[len("volume://"):].partition("/")
            return vol, path
        return None

    def to_dict(self) -> dict:
        return {k: v for k, v in asdict(self).items() if v not in ("", 0) or k in ("name", "direction", "uri")}


def parse_artifacts(log: str, run: str = "", project: str = "") -> list[Artifact]:
    """Every AIF_ARTIFACT line in a log, the last one winning for a (direction, name)."""
    out: dict[tuple[str, str], Artifact] = {}
    for line in (log or "").splitlines():
        at = line.find(ARTIFACT_MARKER)
        if at < 0:
            continue
        try:
            d = json.loads(line[at + len(ARTIFACT_MARKER):])
        except ValueError:
            continue
        if not isinstance(d, dict) or not d.get("name") or not d.get("uri") or d.get("direction") not in ("input", "output"):
            continue
        a = Artifact(name=str(d["name"]), direction=d["direction"], uri=str(d["uri"]),
                     kind=d.get("kind") if d.get("kind") in KINDS else "other",
                     sha256=str(d.get("sha256") or ""), bytes=int(d.get("bytes") or 0), run=run, project=project)
        out[(a.direction, a.name)] = a
    return list(out.values())


def checkpoint_volume(aijob: dict) -> str:
    """The volume a run's checkpoints:// paths are on: the existing one it was given, else the one the
    chart created for it (<run>-checkpoints)."""
    st = ((aijob.get("spec") or {}).get("values") or {}).get("storage") or {}
    if st.get("checkpointPVC"):
        return st["checkpointPVC"]
    name = aijob["metadata"]["name"]
    return (name[:52].rstrip("-") if len(name) > 52 else name) + "-checkpoints"


def resolve(a: Artifact, aijob: dict) -> Artifact:
    """checkpoints://<path> as volume://<the run's checkpoint volume>/<path>; other URIs as they are."""
    if a.uri.startswith("checkpoints://"):
        a.uri = f"volume://{checkpoint_volume(aijob)}/{a.uri[len('checkpoints://'):].lstrip('/')}"
    return a


def stored(aijob: dict) -> list[Artifact] | None:
    """The artifacts kept on an AIJob, or None if none were captured."""
    raw = ((aijob.get("metadata") or {}).get("annotations") or {}).get(ARTIFACTS_ANNOTATION)
    if not raw:
        return None
    md = aijob["metadata"]
    try:
        return [Artifact(**{**d, "run": md["name"], "project": md.get("namespace", "")}) for d in json.loads(raw)]
    except (ValueError, TypeError):
        return None


def artifacts_of(c: "Client", name: str, project: str, capture: bool = True, finished: bool = False,
                 portable: dict[str, str] | None = None) -> list[Artifact]:
    """A run's artifacts: those kept on its AIJob, else read from its log (and, for a finished run,
    kept on the AIJob from then on when capture). finished: the caller saw the run end (its Job
    completes a few seconds before the operator moves the AIJob's phase on). portable maps a URI as the run
reported it (file:// in its pod) to where that input is, for the record."""
    aj = c.conn.custom.get_namespaced_custom_object(*AIJOB[:2], project, AIJOB[2], name)
    have = stored(aj)
    if have is not None:
        return have
    try:
        log = c.runs.get(name, project).logs(tail=None, print_=False) or ""
    except LookupError:
        return []  # no pods any more, and nothing was kept
    found = [resolve(a, aj) for a in parse_artifacts(log, name, project)]
    for a in found:  # an input the run saw at a path in its pod, recorded as where it is (portable)
        if portable and a.direction == "input":
            a.uri = portable.get(a.uri.rstrip("/"), a.uri)
    phase = (aj.get("status") or {}).get("phase", "")
    if capture and found and (finished or phase in ("Succeeded", "Failed", "Cancelled")):
        body = json.dumps([{k: v for k, v in a.to_dict().items() if k not in ("run", "project")} for a in found], separators=(",", ":"))
        c.conn.custom.patch_namespaced_custom_object(*AIJOB[:2], project, AIJOB[2], name,
                                                     {"metadata": {"annotations": {ARTIFACTS_ANNOTATION: body}}})
    return found


def folder_sha256(path: str) -> str:
    """A folder's content hash: SHA-256 over each file's path (relative, sorted) and SHA-256, so the
    same files give the same hash wherever they are. A file's own SHA-256 for a file."""
    if os.path.isfile(path):
        return file_sha256(path)
    h = hashlib.sha256()
    for root, _, files in sorted(os.walk(path)):
        for f in sorted(files):
            p = os.path.join(root, f)
            h.update(f"{os.path.relpath(p, path)}\0{file_sha256(p)}\n".encode())
    return h.hexdigest()


def file_sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def report_line(direction: str, name: str, uri: str, kind: str = "other", sha256: str = "", size: int = 0) -> str:
    """The AIF_ARTIFACT line a run prints (for scripts that import the SDK; others print it themselves)."""
    d: dict[str, Any] = {"direction": direction, "name": name, "kind": kind, "uri": uri}
    if sha256:
        d["sha256"] = sha256
    if size:
        d["bytes"] = size
    return ARTIFACT_MARKER + json.dumps(d, separators=(",", ":"))
