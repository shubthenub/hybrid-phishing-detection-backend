from datasets import load_dataset
from transformers import (
    AutoTokenizer, AutoModelForSequenceClassification,
    TrainingArguments, Trainer
)
from sklearn.metrics import classification_report
import numpy as np

MODEL_NAME = "distilbert-base-uncased"
OUTPUT_DIR = "./model_checkpoint"

print("[TRAIN] Loading dataset...")
ds = load_dataset("zefang-liu/phishing-email-dataset")
ds = ds.map(lambda x: {
    "text": x["Email Text"],
    "label": 1 if x["Email Type"] == "Phishing Email" else 0
})

print("[TRAIN] Loading tokenizer...")
tokenizer = AutoTokenizer.from_pretrained(MODEL_NAME)

def tokenize(batch):
    texts = [str(t) if t is not None else "" for t in batch["text"]]
    return tokenizer(
        texts,
        truncation=True,
        padding="max_length",
        max_length=256
    )

print("[TRAIN] Tokenizing...")
tokenized = ds.map(tokenize, batched=True)
split = tokenized["train"].train_test_split(test_size=0.2, seed=42)
train_ds = split["train"]
eval_ds  = split["test"]

print("[TRAIN] Loading model...")
model = AutoModelForSequenceClassification.from_pretrained(
    MODEL_NAME, num_labels=2
)

args = TrainingArguments(
    output_dir=OUTPUT_DIR,
    num_train_epochs=3,
    per_device_train_batch_size=16,
    per_device_eval_batch_size=32,
    eval_strategy="epoch",
    save_strategy="epoch",
    load_best_model_at_end=True,
    metric_for_best_model="eval_loss",
    learning_rate=2e-5,
    weight_decay=0.01,
    logging_steps=50,
)

trainer = Trainer(
    model=model,
    args=args,
    train_dataset=train_ds,
    eval_dataset=eval_ds,
)

print("[TRAIN] Starting training...")
trainer.train()
trainer.save_model(OUTPUT_DIR)
tokenizer.save_pretrained(OUTPUT_DIR)
print(f"[TRAIN] Model saved to {OUTPUT_DIR}")

preds_output = trainer.predict(eval_ds)
preds = np.argmax(preds_output.predictions, axis=1)
labels = eval_ds["label"]
print("\n[TRAIN] Evaluation Results:")
print(classification_report(labels, preds, target_names=["Legitimate","Phishing"]))
