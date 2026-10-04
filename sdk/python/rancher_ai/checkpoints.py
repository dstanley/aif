"""Checkpoint volumes a run created and kept: list them, look inside, delete the ones you no longer
need. Only volumes the gpu-train-job chart made for a run (<run>-checkpoints with the chart's labels)
are touched, never a dataset or a shared PVC, and never one a pod is still using. With Longhorn and
most CSI classes (reclaimPolicy Delete) deleting the claim deletes the data for good."""

from __future__ import annotations

import base64
import os
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any

from kubernetes import client

from .display import Table
from .workloads import age

if TYPE_CHECKING:
    from .client import Client

CHART = "gpu-train-job"
SUFFIX = "-checkpoints"
TOOLS_IMAGE = "busybox:1.36"


class CheckpointError(RuntimeError):
    """A delete the guardrails refused: not a run's volume, in use, or not confirmed."""


@dataclass
class Checkpoint:
    client: "Client" = field(repr=False)
    name: str
    namespace: str
    run: str
    profile: str = ""
    size: str = ""
    storage_class: str = ""
    phase: str = ""
    created: datetime | None = None
    in_use_by: list[str] = field(default_factory=list)
    run_active: bool = False
    reclaim_policy: str = ""

    def __repr__(self) -> str:
        return f"<Checkpoint {self.name} run={self.run} size={self.size} in_use={bool(self.in_use_by)}>"

    @property
    def in_use(self) -> bool:
        return bool(self.in_use_by) or self.run_active

    def ls(self, path: str = "", max_entries: int = 200, timeout: float = 120) -> str:
        """List the volume's files, from a short-lived read-only pod (deleted afterwards)."""
        if self.in_use_by:
            raise CheckpointError(f"{self.name} is mounted by {', '.join(self.in_use_by)}; look from that pod instead")
        return _ls(self.client, self.namespace, self.name, path, max_entries, timeout)

    def get(self, path: str, dest: str = ".", timeout: float = 300) -> str:
        """Copy one file off the volume (a diagnostics bundle, a model adapter) to `dest`, a directory or a
        file name. Read through a short-lived Job's log, so for files up to some tens of MB."""
        if self.in_use_by:
            raise CheckpointError(f"{self.name} is mounted by {', '.join(self.in_use_by)}; copy from that pod instead")
        src = "/ckpt/" + path.lstrip("/")
        out = _job(self.client, self.namespace, self.name, f"test -f {src!r} || {{ echo NOFILE; exit 3; }}; echo BEGIN; base64 {src!r}; echo END", timeout)
        if "NOFILE" in out or "BEGIN" not in out:
            raise FileNotFoundError(f"{path} is not a file on {self.name}")
        body = out.split("BEGIN", 1)[1].split("END", 1)[0]
        target = os.path.join(dest, os.path.basename(path)) if os.path.isdir(dest) else dest
        with open(target, "wb") as f:
            f.write(base64.b64decode("".join(body.split())))
        return target

    def delete(self, confirm: bool = False) -> None:
        """Delete the volume and, with a Delete reclaim policy, its data. confirm=True is required."""
        self.client.checkpoints.delete(self.name, project=self.namespace, confirm=confirm)


class Checkpoints:
    def __init__(self, c: "Client"):
        self.c = c

    def list(self, project: str | None = None, all_projects: bool = False) -> list[Checkpoint]:
        ns = None if all_projects else (project or self.c.project)
        core = self.c.conn.core
        sel = f"app.kubernetes.io/name={CHART}"
        pvcs = (core.list_namespaced_persistent_volume_claim(ns, label_selector=sel) if ns
                else core.list_persistent_volume_claim_for_all_namespaces(label_selector=sel)).items
        if not pvcs:
            return []
        pods = (core.list_namespaced_pod(ns) if ns else core.list_pod_for_all_namespaces()).items
        mounts: dict[tuple[str, str], list[str]] = {}
        for p in pods:
            if p.status.phase in ("Succeeded", "Failed"):
                continue
            for v in p.spec.volumes or []:
                if v.persistent_volume_claim:
                    mounts.setdefault((p.metadata.namespace, v.persistent_volume_claim.claim_name), []).append(p.metadata.name)
        jobs = {(j.metadata.namespace, j.metadata.name): (j.status.active or 0) > 0
                for j in (self.c.conn.batch.list_namespaced_job(ns, label_selector=sel) if ns
                          else self.c.conn.batch.list_job_for_all_namespaces(label_selector=sel)).items}
        reclaim = _reclaim_policies(self.c)
        out = []
        for v in pvcs:
            run = _run_of(v)
            if not run:
                continue  # a chart-labelled PVC that is not a run's checkpoint volume (e.g. scratch)
            labels = v.metadata.labels or {}
            out.append(Checkpoint(
                client=self.c, name=v.metadata.name, namespace=v.metadata.namespace, run=run,
                profile=labels.get("trainingjobs/profile", ""),
                size=(v.status.capacity or {}).get("storage") or (v.spec.resources.requests or {}).get("storage", ""),
                storage_class=v.spec.storage_class_name or "", phase=v.status.phase or "",
                created=v.metadata.creation_timestamp,
                in_use_by=mounts.get((v.metadata.namespace, v.metadata.name), []),
                run_active=jobs.get((v.metadata.namespace, run), False),
                reclaim_policy=reclaim.get(v.spec.storage_class_name or "", ""),
            ))
        return sorted(out, key=lambda x: x.created or datetime.min.replace(tzinfo=timezone.utc))

    def table(self, project: str | None = None, all_projects: bool = False) -> Table:
        rows = [{"name": k.name, "run": k.run, "profile": k.profile or "-", "project": k.namespace, "size": k.size,
                 "class": k.storage_class or "-", "age": age(k.created),
                 "in_use": ("yes: " + ", ".join(k.in_use_by)) if k.in_use_by else ("run active" if k.run_active else "no")}
                for k in self.list(project, all_projects)]
        return Table(rows, ["name", "run", "profile", "project", "size", "class", "age", "in_use"])

    def get(self, name: str, project: str | None = None) -> Checkpoint:
        ns = project or self.c.project
        k = next((k for k in self.list(ns) if k.name == name), None)
        if not k:
            raise LookupError(f"{name} is not a run's checkpoint volume in {ns} (only <run>{SUFFIX} volumes the "
                              f"{CHART} chart created are managed here)")
        return k

    def delete(self, name: str, project: str | None = None, confirm: bool = False) -> None:
        """Delete one run's checkpoint volume. Refuses a volume a run did not create, one in use, and
        anything without confirm=True."""
        k = self.get(name, project)
        if k.in_use_by:
            raise CheckpointError(f"{name} is mounted by {', '.join(k.in_use_by)}")
        if k.run_active:
            raise CheckpointError(f"{name} belongs to run {k.run}, which is still running")
        if not confirm:
            lost = "its data is deleted permanently" if k.reclaim_policy in ("", "Delete") else f"reclaim policy {k.reclaim_policy}: the volume is released, not wiped"
            raise CheckpointError(f"not deleted: pass confirm=True to delete {name} ({k.size}); {lost}")
        self.c.conn.core.delete_namespaced_persistent_volume_claim(name, k.namespace)

    def delete_older_than(self, days: float, project: str | None = None, dry_run: bool = True,
                          confirm: bool = False) -> list[str]:
        """Delete run checkpoint volumes older than `days` that nothing uses. dry_run (the default)
        only returns the names that would go."""
        cutoff = time.time() - days * 86400
        names = [k.name for k in self.list(project)
                 if not k.in_use and k.created and k.created.timestamp() < cutoff]
        if dry_run:
            return names
        if not confirm:
            raise CheckpointError(f"not deleted: pass confirm=True to delete {len(names)} volume(s): {', '.join(names) or 'none'}")
        for n in names:
            self.delete(n, project=project, confirm=True)
        return names


def _run_of(pvc: Any) -> str:
    """The run a PVC is the checkpoint volume of: <instance>-checkpoints, labelled by the chart."""
    labels = pvc.metadata.labels or {}
    run = labels.get("app.kubernetes.io/instance", "")
    expected = (run[:52].rstrip("-") if len(run) > 52 else run) + SUFFIX
    return run if run and pvc.metadata.name == expected and labels.get("app.kubernetes.io/name") == CHART else ""


def _reclaim_policies(c: "Client") -> dict[str, str]:
    try:
        return {s.metadata.name: s.reclaim_policy or "Delete" for s in client.StorageV1Api(c.conn.api).list_storage_class().items}
    except client.ApiException:
        return {}


def _ls(c: "Client", ns: str, claim: str, path: str, max_entries: int, timeout: float) -> str:
    target = "/ckpt/" + path.lstrip("/")
    return _job(c, ns, claim, f"cd {target!r} && du -sh . && ls -la | head -n {int(max_entries) + 3}", timeout)


def _job(c: "Client", ns: str, claim: str, script: str, timeout: float) -> str:
    """Run `script` against the volume (read-only at /ckpt) in a one-pod Job, rather than a bare Pod:
    AI Job Submitter may create Jobs (and read their pods' logs) but not Pods. Returns its log."""
    core, batch = c.conn.core, c.conn.batch
    name = f"ckpt-job-{int(time.time() * 1000) % 10000000}"
    job = client.V1Job(
        metadata=client.V1ObjectMeta(name=name, namespace=ns, labels={"app.kubernetes.io/managed-by": "rancher-ai"}),
        spec=client.V1JobSpec(
            backoff_limit=0, ttl_seconds_after_finished=300,
            template=client.V1PodTemplateSpec(
                metadata=client.V1ObjectMeta(labels={"app.kubernetes.io/managed-by": "rancher-ai"}),
                spec=client.V1PodSpec(
                    restart_policy="Never",
                    containers=[client.V1Container(
                        name="ls", image=TOOLS_IMAGE,
                        command=["sh", "-c", script],
                        volume_mounts=[client.V1VolumeMount(name="ckpt", mount_path="/ckpt", read_only=True)],
                        resources=client.V1ResourceRequirements(requests={"cpu": "20m", "memory": "16Mi"}, limits={"memory": "64Mi"}),
                    )],
                    volumes=[client.V1Volume(name="ckpt", persistent_volume_claim=client.V1PersistentVolumeClaimVolumeSource(claim_name=claim, read_only=True))],
                ),
            ),
        ),
    )
    batch.create_namespaced_job(ns, job)
    try:
        end = time.time() + timeout
        while True:
            j = batch.read_namespaced_job(name, ns)
            if (j.status.succeeded or 0) or (j.status.failed or 0):
                break
            if time.time() > end:
                raise TimeoutError(f"listing {claim} did not finish in {timeout:.0f}s (job {name})")
            time.sleep(2)
        pod = core.list_namespaced_pod(ns, label_selector=f"job-name={name}").items[0]
        return core.read_namespaced_pod_log(pod.metadata.name, ns, _preload_content=False).data.decode(errors="replace")
    finally:
        batch.delete_namespaced_job(name, ns, propagation_policy="Background")
