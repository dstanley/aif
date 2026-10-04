"""LoRA fine-tune of Qwen2.5-1.5B-Instruct on a slice of an instruction dataset, sized for a 6 GiB GPU
share: bf16 weights, gradient checkpointing, short sequences. Model and dataset downloads go to
$SCRATCH_DIR, the adapter to $CHECKPOINT_DIR (the run's kept checkpoint volume)."""
import os, subprocess, sys, time

print("INFO | installing transformers, peft, datasets (about a minute)", flush=True)
subprocess.run([sys.executable, "-m", "pip", "install", "-q", "--no-cache-dir", "transformers==4.46.3", "peft==0.13.2", "datasets==3.1.0", "accelerate==1.1.1"], check=True)

# Under a GPU-memory cap (KAI share + HAMi-core) the cap counts everything the process holds, cached
# blocks included. Expandable segments keep fragmentation down, and a per-process fraction makes
# PyTorch free its cache before the cap would refuse an allocation (logged by HAMi-core as an OOM).
os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")
import torch
torch.cuda.set_per_process_memory_fraction(float(os.environ.get("CUDA_MEMORY_FRACTION", "0.9")))
from datasets import load_dataset
from peft import LoraConfig, get_peft_model
from transformers import AutoModelForCausalLM, AutoTokenizer

MODEL = os.environ.get("MODEL", "Qwen/Qwen2.5-1.5B-Instruct")
STEPS = int(os.environ.get("STEPS", "60"))
SEQ = int(os.environ.get("SEQ_LEN", "256"))
BATCH = int(os.environ.get("BATCH", "2"))
out = os.path.join(os.environ.get("CHECKPOINT_DIR", "/tmp/out"), os.environ.get("RUN_NAME", "lora"))

free, total = torch.cuda.mem_get_info()
print(f"GPU share: {free / 2**30:.2f} GiB free of {total / 2**30:.2f} GiB visible ({torch.cuda.get_device_name(0)})", flush=True)

print(f"INFO | loading {MODEL} (first run downloads ~3 GB to {os.environ.get('HF_HOME', 'the cache')})", flush=True)
tok = AutoTokenizer.from_pretrained(MODEL)
model = AutoModelForCausalLM.from_pretrained(MODEL, torch_dtype=torch.bfloat16).cuda()
model.gradient_checkpointing_enable()
model.enable_input_require_grads()
model = get_peft_model(model, LoraConfig(r=16, lora_alpha=32, lora_dropout=0.05, task_type="CAUSAL_LM",
                                         target_modules=["q_proj", "k_proj", "v_proj", "o_proj"]))
model.print_trainable_parameters()

print(f"INFO | loading {STEPS * BATCH} examples of yahma/alpaca-cleaned", flush=True)
data = load_dataset("yahma/alpaca-cleaned", split=f"train[:{STEPS * BATCH}]")
def text(r):
    msgs = [{"role": "user", "content": (r["instruction"] + "\n" + r["input"]).strip()}, {"role": "assistant", "content": r["output"]}]
    return tok.apply_chat_template(msgs, tokenize=False)
enc = [tok(text(r), truncation=True, max_length=SEQ, return_tensors="pt") for r in data]

print(f"INFO | training: {STEPS} steps, batch {BATCH}, sequences up to {SEQ} tokens", flush=True)
opt = torch.optim.AdamW([p for p in model.parameters() if p.requires_grad], lr=2e-4)
model.train()
t0 = time.time()
for step in range(STEPS):
    batch = enc[step * BATCH:(step + 1) * BATCH]
    loss = sum(model(input_ids=b["input_ids"].cuda(), attention_mask=b["attention_mask"].cuda(), labels=b["input_ids"].cuda()).loss for b in batch) / len(batch)
    loss.backward()
    opt.step()
    opt.zero_grad()
    if step % 10 == 0 or step == STEPS - 1:
        print(f"INFO | step {step + 1}/{STEPS} | loss={loss.item():.3f} | peak {torch.cuda.max_memory_allocated() / 2**30:.2f} GiB | {time.time() - t0:.0f}s", flush=True)

model.save_pretrained(out)
print(f"adapter saved to {out}: {sorted(os.listdir(out))}", flush=True)
