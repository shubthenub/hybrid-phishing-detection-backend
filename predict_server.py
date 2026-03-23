# predict_server.py
# Run with: python predict_server.py
# Runs on port 5001 (internal only, not exposed to outside)

from flask import Flask, request, jsonify
from transformers import AutoTokenizer, AutoModelForSequenceClassification
import torch, os

app = Flask(__name__)
MODEL_PATH = "./model_checkpoint"
FALLBACK = "distilbert-base-uncased"

# Load model once at startup
if os.path.exists(MODEL_PATH):
    tokenizer = AutoTokenizer.from_pretrained(MODEL_PATH)
    model = AutoModelForSequenceClassification.from_pretrained(MODEL_PATH)
    print(f"[ML] Loaded fine-tuned model from {MODEL_PATH}")
else:
    tokenizer = AutoTokenizer.from_pretrained(FALLBACK)
    model = AutoModelForSequenceClassification.from_pretrained(
        FALLBACK, num_labels=2
    )
    print(f"[ML] WARNING: No checkpoint found. Using untrained {FALLBACK}.")
    print("[ML] Run: python train.py  to create the base model first.")

model.eval()

@app.route("/ml-predict", methods=["POST"])
def predict():
    data = request.json
    text = data.get("text", "")[:512]
    inputs = tokenizer(
        text, return_tensors="pt",
        truncation=True, padding="max_length", max_length=256
    )
    with torch.no_grad():
        logits = model(**inputs).logits
    probs = torch.softmax(logits, dim=1)
    
    # Cast PyTorch float to standard Python float manually to appease Pyre
    val = float(probs[0][1].item())
    rounded_score = float(f"{val:.4f}")

    return jsonify({"ml_score": rounded_score})

if __name__ == "__main__":
    app.run(port=5001)
