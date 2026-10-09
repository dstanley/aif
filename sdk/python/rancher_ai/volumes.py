"""Copy a file or a folder of any size off a volume in the project: a run's checkpoints, its scratch
space, a dataset, any PersistentVolumeClaim you can see.

A volume can only be read from a pod that mounts it. get() starts a one-pod Job that mounts the
volume read-only (a Job, which AI Job Submitter may create, rather than a bare Pod), streams the file
out of it over the exec API straight to disk (or a tar of the folder, unpacked as it arrives), checks
the copy against the size on the volume and, for a file named by its SHA-256 (a Hugging Face blob),
against that hash, and deletes the Job. Exec needs the pods/exec permission in the project, which
AI Job Submitter grants. checkpoints.get() copies small files from a run's checkpoint volume without
it, through a Job's log.

copy() copies from one volume to another in the cluster, without the files leaving it: a one-pod
Job mounts both, copies, compares every file's SHA-256 on both sides, and only then puts the copy in
place, so a reader of the destination (a vLLM server loading an adapter) never sees half of it. It
needs no exec; the result comes back through the Job's log.
"""

from __future__ import annotations

import functools
import hashlib
import os
import re
import tarfile
import time
from typing import TYPE_CHECKING, Callable

from kubernetes import client
from kubernetes.stream import stream

try:
    # stream() keeps a copy of everything it reads (a 3 GiB file held in memory); the same call through
    # websocket_call with capture_all=False streams it straight to disk. Both names are the client's own.
    from kubernetes.stream import ws_client
    from kubernetes.stream.stream import _websocket_request

    _stream = functools.partial(_websocket_request, functools.partial(ws_client.websocket_call, capture_all=False), None)
except ImportError:  # a client without them: correct, but the copy is held in memory as it streams
    _stream = stream

from .checkpoints import TOOLS_IMAGE, CheckpointError, target_path

if TYPE_CHECKING:
    from .client import Client

LABEL = {"app.kubernetes.io/managed-by": "rancher-ai", "app.kubernetes.io/name": "volume-get"}
COPY_LABEL = {"app.kubernetes.io/managed-by": "rancher-ai", "app.kubernetes.io/name": "volume-copy"}
COPY_RESULT = "AIF_COPY "
SHA256_NAME = re.compile(r"^[0-9a-f]{64}$")
CHUNK = 1 << 20


def _sh_quote(s: str) -> str:
    return "'" + s.replace("'", "'\\''") + "'"


def volume_path(path: str) -> str:
    """The path inside the pod for a path on the volume, which cannot leave it."""
    parts = [p for p in (path or "").split("/") if p and p != "."]
    if ".." in parts:
        raise ValueError("a path cannot leave the volume")
    return "/data/" + "/".join(parts) if parts else "/data"


def copy_script(src: str, dst: str, overwrite: bool = False) -> str:
    """The shell (BusyBox) that copies src to dst inside the copy pod: into a temporary name beside
    dst, every file's SHA-256 compared with the source's, then renamed into place (replacing dst only
    with overwrite). Its last line is AIF_COPY ok <files> <bytes>, or AIF_COPY <error> <detail>."""
    return f"""set -u
s={_sh_quote(src)}; d={_sh_quote(dst)}
say() {{ echo "{COPY_RESULT}$*"; }}
[ -e "$s" ] || {{ say missing "$s"; exit 2; }}
if [ -e "$d" ] && [ {1 if overwrite else 0} = 0 ]; then say exists "$d"; exit 3; fi
mkdir -p "$(dirname "$d")" || {{ say failed mkdir; exit 4; }}
t="$(dirname "$d")/.copying-$(basename "$d")"
rm -rf "$t"
cp -RL "$s" "$t" || {{ rm -rf "$t"; say failed cp; exit 4; }}
chmod -R a+rX "$t"
sums() {{ if [ -d "$1" ]; then (cd "$1" && find -L . -type f -exec sha256sum {{}} + | sort -k2); else sha256sum < "$1"; fi; }}
if [ "$(sums "$s" | sha256sum)" != "$(sums "$t" | sha256sum)" ]; then rm -rf "$t"; say mismatch "$d"; exit 5; fi
rm -rf "$d" && mv "$t" "$d" || {{ say failed mv; exit 4; }}
n=$(find "$d" -type f | wc -l)
b=$(find "$d" -type f -exec stat -c %s {{}} + | awk '{{t+=$1}} END {{print t+0}}')
say ok "$n" "$b"
"""


def parse_copy(log: str) -> dict:
    """The copy pod's verdict from its log: {files, bytes}, or the error it reported, raised."""
    for line in reversed((log or "").splitlines()):
        if line.startswith(COPY_RESULT):
            word, *rest = line[len(COPY_RESULT):].split(" ", 1)
            detail = rest[0] if rest else ""
            if word == "ok":
                files, size = detail.split()
                return {"files": int(files), "bytes": int(size)}
            msg = {"missing": f"not on the source volume: {detail}",
                   "exists": f"already on the destination: {detail} (overwrite=True replaces it)",
                   "mismatch": "the copy's checksums differ from the source's; nothing was put in place"}.get(word, f"copy failed: {detail}")
            raise CheckpointError(msg)
    raise CheckpointError("the copy pod reported no result; its log: " + (log or "")[-500:])


class _ExecReader:
    """The stdout of an exec as a file object tarfile can read as a stream (mode 'r|')."""

    def __init__(self, ws, on_bytes: Callable[[int], None] | None = None):
        self.ws, self.buf, self.on_bytes = ws, b"", on_bytes

    def read(self, n: int = -1) -> bytes:
        while (n < 0 or len(self.buf) < n) and self.ws.is_open():
            self.ws.update(timeout=1)
            if self.ws.peek_stdout():
                data = self.ws.read_stdout()
                self.buf += data
                if self.on_bytes:
                    self.on_bytes(len(data))
        if n < 0:
            out, self.buf = self.buf, b""
        else:
            out, self.buf = self.buf[:n], self.buf[n:]
        return out


def _progress(total: int | None, quiet: bool) -> Callable[[int], None]:
    """Print every 10% of a known size (or every 256 MiB of an unknown one), unless quiet."""
    seen, step, nxt = [0], (total // 10 if total else 256 << 20) or 1, [0]
    nxt[0] = step

    def on(n: int) -> None:
        seen[0] += n
        if quiet or seen[0] < nxt[0]:
            return
        nxt[0] += step
        if total:
            print(f"  {seen[0] * 100 // total}%  {seen[0] >> 20} of {total >> 20} MiB", flush=True)
        else:
            print(f"  {seen[0] >> 20} MiB", flush=True)
    return on


class Volumes:
    def __init__(self, c: "Client"):
        self.c = c

    def get(self, volume: str, path: str, dest: str = ".", project: str | None = None,
            timeout: float = 3600, quiet: bool = False) -> str:
        """Copy `path` (a file or a folder, from the volume's root) off `volume` to `dest`: a directory
        (created when it ends in "/"), or a file name; "~" is expanded. A folder keeps its name inside
        `dest`, and links in it are copied as the files they point to. Returns the absolute path written."""
        ns = project or self.c.project
        core, batch = self.c.conn.core, self.c.conn.batch
        try:
            core.read_namespaced_persistent_volume_claim(volume, ns)
        except client.ApiException as e:
            if e.status == 404:
                raise LookupError(f"no volume {volume} in {ns}") from None
            raise
        src = volume_path(path)
        name = f"volume-get-{int(time.time() * 1000) % 10000000}"
        batch.create_namespaced_job(ns, client.V1Job(
            metadata=client.V1ObjectMeta(name=name, namespace=ns, labels=LABEL),
            spec=client.V1JobSpec(
                backoff_limit=0, ttl_seconds_after_finished=60, active_deadline_seconds=int(timeout) + 300,
                template=client.V1PodTemplateSpec(
                    metadata=client.V1ObjectMeta(labels=LABEL),
                    spec=client.V1PodSpec(
                        restart_policy="Never", termination_grace_period_seconds=1,
                        containers=[client.V1Container(
                            name="get", image=TOOLS_IMAGE, command=["sleep", str(int(timeout) + 300)],
                            volume_mounts=[client.V1VolumeMount(name="data", mount_path="/data", read_only=True)],
                            resources=client.V1ResourceRequirements(requests={"cpu": "50m", "memory": "32Mi"}, limits={"memory": "128Mi"}),
                        )],
                        volumes=[client.V1Volume(name="data", persistent_volume_claim=client.V1PersistentVolumeClaimVolumeSource(claim_name=volume, read_only=True))],
                    ),
                ),
            ),
        ))
        try:
            pod = self._wait_running(ns, name, volume)
            kind = self._exec_text(ns, pod, f"p={_sh_quote(src)}; if [ -d \"$p\" ]; then echo dir; "
                                            f"elif [ -f \"$p\" ]; then echo file $(stat -c %s \"$p\"); else echo none; fi").split()
            if not kind or kind[0] == "none":
                raise FileNotFoundError(f"{path} is not on {volume}")
            if kind[0] == "file":
                return self._get_file(ns, pod, src, int(kind[1]), target_path(dest, path), quiet)
            return self._get_dir(ns, pod, src, dest, quiet)
        finally:
            try:
                batch.delete_namespaced_job(name, ns, propagation_policy="Background")
            except client.ApiException:
                pass

    def copy(self, volume: str, path: str, to: str, to_path: str | None = None, project: str | None = None,
             size: str | None = None, storage_class: str | None = None, overwrite: bool = False,
             timeout: float = 3600, quiet: bool = False) -> dict:
        """Copy `path` (a file or a folder) from `volume` to the volume `to`, in the cluster, as
        `to_path` on it (default: the same name, at its root). Both volumes are in the project. A
        destination volume that does not exist is created when `size` is given (e.g. "10Gi", of
        `storage_class` or the cluster default). Nothing replaces an existing path unless overwrite.
        Returns {"files", "bytes", "volume", "path"}.

            ai.volumes.copy("train-aobpo-checkpoints", "train-aobpo/adapter",
                            "vllm-qwen-32b-storage-claim", "lora-adapters/suse-32b")
        """
        ns = project or self.c.project
        core, batch = self.c.conn.core, self.c.conn.batch
        for v in (volume, to):
            try:
                core.read_namespaced_persistent_volume_claim(v, ns)
            except client.ApiException as e:
                if e.status != 404:
                    raise
                if v == volume or not size:
                    raise LookupError(f"no volume {v} in {ns}" + ("" if v == volume else "; pass size= to create it")) from None
                core.create_namespaced_persistent_volume_claim(ns, client.V1PersistentVolumeClaim(
                    metadata=client.V1ObjectMeta(name=to, labels={"app.kubernetes.io/managed-by": "rancher-ai"}),
                    spec=client.V1PersistentVolumeClaimSpec(access_modes=["ReadWriteOnce"], storage_class_name=storage_class,
                                                            resources=client.V1VolumeResourceRequirements(requests={"storage": size})
                                                            if hasattr(client, "V1VolumeResourceRequirements") else
                                                            client.V1ResourceRequirements(requests={"storage": size}))))
                if not quiet:
                    print(f"Created volume {to} ({size})", flush=True)
        src = volume_path(path).replace("/data", "/src", 1)
        dst = volume_path(to_path if to_path is not None else os.path.basename(path.rstrip("/"))).replace("/data", "/dst", 1)
        if dst == "/dst":
            raise ValueError("to_path must name a file or folder on the destination, not its root")
        # a volume a running pod mounts can only be mounted on that pod's node (a single-node volume)
        node = self._node_using(ns, {volume, to})
        name = f"volume-copy-{int(time.time() * 1000) % 10000000}"
        mounts = [client.V1VolumeMount(name="src", mount_path="/src", read_only=True), client.V1VolumeMount(name="dst", mount_path="/dst")]
        batch.create_namespaced_job(ns, client.V1Job(
            metadata=client.V1ObjectMeta(name=name, namespace=ns, labels=COPY_LABEL),
            spec=client.V1JobSpec(
                backoff_limit=0, ttl_seconds_after_finished=300, active_deadline_seconds=int(timeout),
                template=client.V1PodTemplateSpec(
                    metadata=client.V1ObjectMeta(labels=COPY_LABEL),
                    spec=client.V1PodSpec(
                        restart_policy="Never", termination_grace_period_seconds=1,
                        **({"node_selector": {"kubernetes.io/hostname": node}} if node else {}),
                        containers=[client.V1Container(
                            name="copy", image=TOOLS_IMAGE, command=["sh", "-c", copy_script(src, dst, overwrite)],
                            volume_mounts=mounts,
                            resources=client.V1ResourceRequirements(requests={"cpu": "100m", "memory": "32Mi"}, limits={"memory": "256Mi"}),
                        )],
                        volumes=[client.V1Volume(name="src", persistent_volume_claim=client.V1PersistentVolumeClaimVolumeSource(claim_name=volume, read_only=True)),
                                 client.V1Volume(name="dst", persistent_volume_claim=client.V1PersistentVolumeClaimVolumeSource(claim_name=to))],
                    ),
                ),
            ),
        ))
        if not quiet:
            print(f"Copying {volume}:{path} to {to}:{dst[len('/dst/'):]}" + (f" (on {node}, where it is mounted)" if node else ""), flush=True)
        try:
            pod = self._wait_done(ns, name, f"{volume} and {to}", timeout)
            out = parse_copy(core.read_namespaced_pod_log(pod, ns, container="copy"))
        finally:
            try:
                batch.delete_namespaced_job(name, ns, propagation_policy="Background")
            except client.ApiException:
                pass
        out.update(volume=to, path=dst[len("/dst/"):])
        if not quiet:
            print(f"Copied {out['files']} files, {out['bytes'] >> 20} MiB, checksums match", flush=True)
        return out

    def _node_using(self, ns: str, claims: set[str]) -> str | None:
        for p in self.c.conn.core.list_namespaced_pod(ns).items:
            if p.status.phase not in ("Running", "Pending") or not p.spec.node_name:
                continue
            if any(v.persistent_volume_claim and v.persistent_volume_claim.claim_name in claims for v in (p.spec.volumes or [])):
                return p.spec.node_name
        return None

    def _wait_done(self, ns: str, job: str, what: str, timeout: float) -> str:
        """The finished copy pod's name; an error if it cannot start (the volumes on different nodes)."""
        core, start = self.c.conn.core, time.time()
        while time.time() < start + timeout:
            pods = core.list_namespaced_pod(ns, label_selector=f"job-name={job}").items
            for p in pods:
                if p.status.phase in ("Succeeded", "Failed"):
                    return p.metadata.name
                if p.status.phase == "Pending" and time.time() > start + 180:
                    why = "; ".join(c.message for c in (p.status.conditions or []) if c.message) or "still pending"
                    raise CheckpointError(f"the copy pod for {what} did not start within 180 s ({why}); "
                                          f"two single-node volumes on different nodes cannot be mounted together")
            time.sleep(2)
        raise CheckpointError(f"the copy of {what} did not finish within {int(timeout)} s")

    def _wait_running(self, ns: str, job: str, volume: str, timeout: float = 180) -> str:
        core, end = self.c.conn.core, time.time() + timeout
        while time.time() < end:
            for p in core.list_namespaced_pod(ns, label_selector=f"job-name={job}").items:
                if p.status.phase == "Running":
                    return p.metadata.name
            time.sleep(2)
        raise CheckpointError(f"the pod reading {volume} did not start within {int(timeout)} s; is {volume} "
                              f"mounted by a running pod on another node?")

    def _exec(self, ns: str, pod: str, command: list[str]):
        return _stream(self.c.conn.core.connect_get_namespaced_pod_exec, pod, ns, command=command,
                       stderr=True, stdin=False, stdout=True, tty=False, _preload_content=False, binary=True)

    def _exec_text(self, ns: str, pod: str, script: str) -> str:
        ws, out = self._exec(ns, pod, ["sh", "-c", script]), b""
        while ws.is_open():
            ws.update(timeout=1)
            if ws.peek_stdout():
                out += ws.read_stdout()
        ws.close()
        return out.decode("utf-8", "replace").strip()

    def _get_file(self, ns: str, pod: str, src: str, size: int, target: str, quiet: bool) -> str:
        part, got = target + ".part", 0
        named = SHA256_NAME.match(os.path.basename(src))
        sha = hashlib.sha256() if named else None
        on = _progress(size, quiet)
        if not quiet:
            print(f"Copying {src[len('/data/'):]} ({size >> 20} MiB) to {target}", flush=True)
        ws = self._exec(ns, pod, ["cat", src])
        with open(part, "wb") as f:
            while ws.is_open():
                ws.update(timeout=1)
                if ws.peek_stdout():
                    data = ws.read_stdout()
                    f.write(data)
                    got += len(data)
                    if sha:
                        sha.update(data)
                    on(len(data))
        ws.close()
        if got != size:
            os.remove(part)
            raise CheckpointError(f"copy incomplete: {got} of {size} bytes")
        if sha and sha.hexdigest() != os.path.basename(src):
            os.remove(part)
            raise CheckpointError(f"checksum mismatch: got {sha.hexdigest()}")
        os.replace(part, target)
        return target

    def _get_dir(self, ns: str, pod: str, src: str, dest: str, quiet: bool) -> str:
        parent, base = src.rsplit("/", 1)
        out_dir = os.path.abspath(os.path.expanduser(dest or "."))
        os.makedirs(out_dir, exist_ok=True)
        count = int(self._exec_text(ns, pod, f"find -L {_sh_quote(src)} -type f | wc -l") or 0)
        if not quiet:
            print(f"Copying folder {src[len('/data/'):]} ({count} files) into {out_dir}", flush=True)
        ws = self._exec(ns, pod, ["tar", "-C", parent or "/", "-chf", "-", base])
        reader = _ExecReader(ws, _progress(None, quiet))
        with tarfile.open(fileobj=reader, mode="r|") as tar:
            # the data filter refuses absolute paths, links out of out_dir and device files
            tar.extractall(out_dir, filter="data") if hasattr(tarfile, "data_filter") else tar.extractall(out_dir)
        ws.close()
        root = os.path.join(out_dir, base)
        got = sum(len(files) for _, _, files in os.walk(root))
        if got < count:
            raise CheckpointError(f"copy incomplete: {got} of {count} files")
        return root
