# PhishGuard

## Prerequisites
- Node.js 18+
- Python 3.10+
- Docker (for Redis) OR redis-server installed locally

## Step 1 — Install dependencies
  npm install
  pip install -r requirements.txt

## Step 2 — Start Redis
  docker run -d -p 6379:6379 redis
  # OR if Redis is installed locally:
  redis-server

## Step 3 — Train the base model (run ONCE, takes 20-40 min)
  python train.py
  # This downloads distilbert-base-uncased from HuggingFace automatically
  # Saves fine-tuned weights to ./model_checkpoint/
  # You only ever run this once

## Step 4 — Start the ML inference server (keep this terminal open)
  python predict_server.py
  # Runs on port 5001 (internal)
  # Loads model from ./model_checkpoint/

## Step 5 — Start the main API server (new terminal)
  node server.js
  # Runs on port 8000

## Step 6 — Run the demo
  npm test

## Triggering fine-tuning (when buffer has 150+ confirmed samples)
  curl -X POST http://localhost:8000/admin/finetune
  # Spawns finetune.py as a subprocess
  # Streams training logs to console
  # On success: deletes Redis keys, archives buffer, updates model
