import sys, json, argparse, os, time
from datasets import Dataset
from transformers import (
    AutoTokenizer, AutoModelForSequenceClassification,
    TrainingArguments, Trainer
)

MODEL_PATH = "./model_checkpoint"
RESULT_PATH = "./data/results"
os.makedirs(RESULT_PATH, exist_ok=True)

parser = argparse.ArgumentParser()
parser.add_argument("--batch", required=True)
args = parser.parse_args()

print(f"[FINETUNE] Loading {args.batch}...")
samples = []
ioc_hashes = []
with open(args.batch) as f:
    for line in f:
        entry = json.loads(line.strip())
        samples.append({"text": entry["text"], "label": entry["label"]})
        if entry.get("ioc_hash"):
            ioc_hashes.append(entry["ioc_hash"])

print(f"[FINETUNE] {len(samples)} samples loaded. {len(set(ioc_hashes))} unique IoCs.")

tokenizer = AutoTokenizer.from_pretrained(MODEL_PATH)
model = AutoModelForSequenceClassification.from_pretrained(MODEL_PATH)

dataset = Dataset.from_list(samples)

def tokenize(batch):
    texts = [str(t) if t is not None else "" for t in batch["text"]]
    return tokenizer(texts, truncation=True, padding="max_length", max_length=256)

dataset = dataset.map(tokenize, batched=True)

args_train = TrainingArguments(
    output_dir=MODEL_PATH,
    num_train_epochs=1,
    per_device_train_batch_size=8,
    learning_rate=1e-5,
    save_strategy="no",
    logging_steps=10,
)

trainer = Trainer(model=model, args=args_train, train_dataset=dataset)
print("[FINETUNE] Training...")
trainer.train()

# Wait for Windows to settle
time.sleep(2)

# Rename locked safetensors so save doesn't conflict
safetensors_path = os.path.join(MODEL_PATH, "model.safetensors")
backup_path = os.path.join(MODEL_PATH, "model.safetensors.bak")

if os.path.exists(safetensors_path):
    try:
        os.rename(safetensors_path, backup_path)
        print("[FINETUNE] Renamed safetensors to .bak")
    except Exception as e:
        print(f"[FINETUNE] Rename failed: {e}")

# Save as pytorch bin — avoids safetensors lock entirely
trainer.model.save_pretrained(MODEL_PATH, safe_serialization=False)
tokenizer.save_pretrained(MODEL_PATH)
print(f"[FINETUNE] Model saved to {MODEL_PATH}")

# Clean up backup
if os.path.exists(backup_path):
    os.remove(backup_path)
    print("[FINETUNE] Backup cleaned up")

# Write result for Node.js to read
from datetime import datetime
timestamp = datetime.now().strftime("%Y-%m-%dT%H-%M-%S")
result_path = os.path.join(RESULT_PATH, f"result_{timestamp}.json")

result = {
    "success": True,
    "samples_trained": len(samples),
    "ioc_hashes": list(set(ioc_hashes)),
    "timestamp": timestamp
}


with open(result_path, "w") as f:
    json.dump(result, f)

with open(os.path.join(RESULT_PATH, "latest.json"), "w") as f:
    json.dump(result, f)

print(f"[FINETUNE] Result written to {result_path}")
print(f"[FINETUNE] Finished successfully")