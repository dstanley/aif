# Run artifacts: what a run consumed and produced

A run's record (its AIJob) says how it ran: its profile, queue, nodes, GPUs, result and metrics.
This adds what it worked on: the base model and dataset it consumed and the model it produced, each
by where it is and by content. That answers which data and which model revision produced an adapter,
which run produced it, and whether it has changed since.

The format is independent of any one consumer. The SDK reads and writes it first; the AI Jobs UI,
the AIJob operator and a Kubeflow Pipelines integration read the same records.

## Reporting: one line per artifact

A run reports its artifacts in its first worker's log, as it reports its result (`AIF_RESULT`):

```
AIF_ARTIFACT {"direction":"output","name":"adapter","kind":"model","uri":"checkpoints://train-1/adapter","sha256":"5e37…","bytes":35239304}
```

| Field | Required | Meaning |
|---|---|---|
| `direction` | yes | `input` or `output` |
| `name` | yes | the run's own name for it (`adapter`, `dataset`, `base-model`); unique per direction, the last line wins |
| `uri` | yes | where it is (below) |
| `kind` | no | `model`, `dataset`, `metrics`, `code` or `other` (the default) |
| `sha256` | no | its content hash (below); without one, an artifact is identified by its URI alone |
| `bytes` | no | its size |

## Where it is: URIs

| Scheme | Names | Example |
|---|---|---|
| `checkpoints://<path>` | a path on the reporting run's own checkpoint volume; resolved to `volume://` when recorded | `checkpoints://train-1/adapter` |
| `volume://<pvc>/<path>` | a path on a volume in the run's project | `volume://train-1-checkpoints/train-1/adapter` |
| `hf://<repo>@<commit>` | a Hugging Face model at a commit | `hf://Qwen/Qwen2.5-0.5B-Instruct@7ae5576…` |
| `hf-dataset://<repo>@<commit>/<file>` | a file of a Hugging Face dataset at a commit | `hf-dataset://yahma/alpaca-cleaned@12567ca…/alpaca_data_cleaned.json` |
| `file://<path>` | a path inside the run's pods (a mounted ConfigMap); meaningful only to that run | `file:///mnt/config/train.jsonl` |
| `s3://<bucket>/<key>`, `oci://<ref>` | reserved: object storage, an OCI registry (Harbor) | |

A recorded artifact is portable: `checkpoints://` is resolved to the volume, and an input a run saw
at a path in its pod is recorded where it is (the SDK's chain knows what it handed the run).

## Content: the hash

`sha256` is the SHA-256 of a file. For a folder (a LoRA adapter is several files) it is the SHA-256
of one line per file, in the order of their paths relative to the folder, sorted:

```
<relative path>\0<the file's SHA-256>\n
```

so the same files give the same hash wherever they are, and any change to any file changes it.
Matching hashes is how a consumer is linked to its producer, whatever either calls the artifact.

## Where it is kept

The log goes with the run's pods, so a finished run's artifacts are kept on its AIJob:

- now: the annotation `ai-factory.suse.com/artifacts`, a JSON list of the fields above (URIs
  resolved), written by the SDK when it sees the run finish;
- next: `status.artifacts`, captured by the operator when the run finishes, as it captures
  `status.report`, so it no longer depends on a client being there.

Keeping the record does not keep the files: a volume deleted takes its artifacts with it, and the
record then names something that is gone. Keeping a model is publishing it somewhere durable (a
models volume, object storage, an OCI registry) as an artifact of its own.

## Chains

Runs that feed each other carry, on their AIJobs:

| | Key | Value |
|---|---|---|
| label | `ai-factory.suse.com/chain` | the chain's name |
| label | `ai-factory.suse.com/step` | the step's name |
| annotation | `ai-factory.suse.com/parents` | the runs whose outputs it consumed, comma-separated |
| annotation | `ai-factory.suse.com/inputs` | the inputs it was given: `{name: artifact}` |
| annotation | `ai-factory.suse.com/inputs-hash` | the step's key: its profile, the values its run installs, the training chart version, a code ConfigMap's contents, and its inputs by content |

A run with the same key that succeeded, its outputs still there, can stand in for a new one. The
chain is the AIJobs' labels and annotations, not an object of its own: AIJob stays the record of
each run, and whatever orchestrates (a notebook, Kubeflow Pipelines) keeps the relationships
between runs through them.

## In the UI

"Artifacts" rather than "lineage": a run's detail lists what it used and produced, and for an input,
the run that produced it.
