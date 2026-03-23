# Hybrid Phishing Email Detection System

A real-time phishing detection backend combining a fine-tuned DistilBERT classifier with a Redis-backed crowdsourced reputation engine and a human-in-the-loop incremental fine-tuning pipeline.

---

## The Problem This Solves

A phishing email sent to students at Manipal University Jaipur — impersonating an institutional internship program in collaboration with IIT Roorkee, linking to a Google Form on a legitimate domain — scored **0.0053** on a well-trained DistilBERT classifier. Classified as SAFE.

The model was not broken. The email genuinely reads like a legitimate institutional communication. This is the ceiling of ML-only detection. Sophisticated social engineering that mimics real institutional language, uses legitimate platforms, and targets specific communities cannot be caught by a model trained on historical phishing datasets alone.

This system addresses that gap.

---

## How It Works

Three components operate at different timescales:

**Real-time (milliseconds):** Every incoming email is classified by DistilBERT and simultaneously checked against Redis for prior crowd reports. Both scores are fused into a single probability using a weighted formula. Response time: 18ms on the Redis path, ~200ms on the ML path.

**Minutes to hours:** As users report a suspicious email, Redis accumulates weighted votes. When enough trusted reporters flag the same email (R ≥ 0.90, minimum 5 reporters), the email is added to a confirmed buffer. The Redis key stays alive — users continue receiving warnings — until fine-tuning completes.

**Batch (hours to days):** When the buffer accumulates 150+ confirmed samples, an incremental fine-tuning cycle runs. The model trains for one epoch on the new data at a reduced learning rate, updates the checkpoint, and the Redis keys for trained IoCs are evicted. The model now catches those threats natively.

---

## Architecture

```
Incoming Email
      │
      ▼
Express.js API Server (server.js)
  ├── extracts IoC hash (SHA-256 of sender domain + first URL)
  ├── calls ML inference server
  └── queries Redis reputation engine
      │                    │
      ▼                    ▼
Flask / DistilBERT    Redis Hash Map
predict_server.py     (per IoC)
returns P_ML          returns R_redis
      │                    │
      └──────────┬──────────┘
                 ▼
         Decision Fusion
   FinalScore = (1-R)·P_ML + R·R
                 │
                 ▼
    SAFE · SUSPICIOUS · PHISHING

User reports email
      │
      ▼
/report endpoint
  → updates Redis score (Eq 7-11)
  → if R ≥ 0.90 AND N ≥ 5:
      append to confirmed_phishing.jsonl (once per IoC)
      Redis key stays alive

/admin/finetune (manual trigger)
  → buffer ≥ 150 samples?
  → spawns finetune.py as subprocess
  → on success: DEL Redis keys, archive buffer
  → on failure: Redis keys preserved
```

---

## The Scoring Algorithm

A naive vote counter is unusable in a security context. It produces unbounded integers with no probabilistic meaning, can be flooded by botnets, and treats rapid-fire automated reports the same as independent human reporters separated by hours.

The scoring algorithm produces a probability R bounded in [0, 1] using three weighted factors per vote:

### W_time — Temporal Spacing

```
W_time(Δt) = α + (1-α)(1 - e^(-μ·Δt))
α = 0.1, μ = 0.005
```

When reports arrive with 50ms gaps (botnet): W_time ≈ 0.10 — minimum weight.
When reports arrive with 30-minute gaps (real users): W_time ≈ 1.0 — maximum weight.

This single formula is what makes the system botnet-resistant without any IP blocking or account verification.

### W_diminish — Diminishing Returns

```
W_diminish(N) = e^(-η·(N-1))
η = 0.4
```

First vote: weight = 1.0. Third vote: weight ≈ 0.45. Sixth vote: weight ≈ 0.08.

Once several trusted users have flagged an email, each additional report adds progressively less. No single source can saturate the score regardless of how many reports they submit.

### u_k — User Trust

Each reporter carries a trust score in (0, 1]. Security analysts with verified histories carry scores near 1.0. New accounts carry 0.1. Default for authenticated users: 0.9.

### Marginal impact and bounded score

```
Δz = u_k · W_time · W_diminish
z  = max(0, z + Δz)
R  = 1 - e^(-κ·z)     κ = 1.5
```

R is always a valid probability. Single trusted reporter after 30 minutes: R ≈ 0.74 (SUSPICIOUS). Three independent reporters with 30-minute gaps: R ≈ 0.94 (PHISHING confirmed).

### Decision Fusion

```
FinalScore = (1 - R_redis) · P_ML + R_redis · R_redis
```

When R_redis = 0: system relies entirely on ML.
When R_redis → 1: crowd overrides ML completely.

The quadratic crowd term ensures the transition is gradual at low confidence and sharp near the threshold — preventing a single early reporter from overriding a well-calibrated model.

**Result on the Manipal email:**
- ML alone: 0.0053 → SAFE
- After 12 crowd reports (30-min gaps): R = 0.9988
- FinalScore: 0.9977 → PHISHING

---

## The Fine-Tuning Pipeline

### Why batch, not per-report

Fine-tuning on every report would take minutes per email on CPU, risk catastrophic forgetting from single-sample updates, and provide no statistical signal — one report proves nothing.

The correct design: accumulate crowd-confirmed samples, fine-tune once per batch of 150+.

### The single-entry constraint

Each IoC contributes exactly one entry to the confirmed buffer, enforced by an `added_to_buffer` flag in the Redis hash. Without this, a campaign generating thousands of reports would flood the buffer with duplicates, creating an imbalanced batch that causes the model to over-specialize on one pattern.

### Why Redis keys are not deleted at threshold crossing

Between R crossing 0.90 and fine-tuning completing, there may be hours or days of new recipients opening the same phishing email. Deleting the Redis key early removes the only protection those users have — the ML model has not yet learned the pattern. Keys are evicted only after `finetune.py` exits successfully and `finetune_result.json` is written.

### Training configuration

- Base model: `distilbert-base-uncased` (HuggingFace)
- Initial training: 3 epochs, lr=2e-5, 18,650 labeled emails
- Incremental fine-tune: 1 epoch, lr=1e-5 (lower rate prevents catastrophic forgetting)
- Saves as `pytorch_model.bin` (not safetensors) to avoid Windows file lock conflicts

### Results from initial training

```
Legitimate:  Precision 0.99  Recall 0.97  F1 0.98  (2274 samples)
Phishing:    Precision 0.96  Recall 0.98  F1 0.97  (1456 samples)
Overall accuracy: 0.97   MCC: ~0.945
```

---

## Stack

| Component | Technology | Why |
|-----------|-----------|-----|
| API server | Node.js + Express | Primary language, fast routing |
| ML inference | Python + Flask | HuggingFace has no mature Node.js equivalent |
| ML model | DistilBERT | 40% smaller than BERT, 60% faster, 97% of BERT accuracy |
| Reputation store | Redis | O(1) lookups, TTL-based expiry, pipeline atomicity |
| Fine-tune | HuggingFace Trainer | Handles training loop, checkpointing, device management |
| Dataset | zefang-liu/phishing-dataset | 18,650 labeled emails, loads via HuggingFace datasets |

---

## File Structure

```
project/
├── server.js               # Express API — all endpoints
├── redis_engine.js         # Scoring math (Eq 7-11) + Redis CRUD
├── scorer.js               # Decision fusion (Eq 12)
├── feature_extractor.js    # SHA-256 IoC hashing, URL extraction
├── ml_client.js            # HTTP calls to predict_server.py
├── predict_server.py       # Flask wrapper for DistilBERT inference
├── finetune.py             # Batch fine-tuning on confirmed buffer
├── train.py                # One-time initial fine-tune (run once)
├── test_demo.js            # End-to-end demo script
├── nodemon.json            # Ignore .jsonl files to prevent restart loops
├── .env                    # Config (ports, thresholds, paths)
├── model_checkpoint/       # Fine-tuned model weights (~250MB)
└── data/
    ├── confirmed_phishing.jsonl    # Active buffer (recreated each cycle)
    ├── archives/                   # Permanent record per fine-tune cycle
    └── results/                    # latest.json + timestamped results
```

---

## API Reference

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/predict` | POST | Classify email, returns ML score + Redis score + FinalScore |
| `/report` | POST | Submit user vote, updates Redis score |
| `/score/:iocHash` | GET | Current Redis reputation score for an IoC |
| `/status` | GET | Active IoC count, buffer size, server health |
| `/health` | GET | Server status |
| `/admin/finetune` | POST | Trigger batch fine-tuning (requires buffer ≥ 150) |
| `/simulate-time` | POST | Backdate last_report_time (demo/testing only) |
| `/reset-ioc` | POST | Delete Redis key for an IoC (demo/testing only) |

---

## Running the Project

**Prerequisites:** Node.js 18+, Python 3.10+, Docker

```bash
# 1. Start Redis
docker run -d -p 6379:6379 redis

# 2. Install dependencies
npm install
pip install flask transformers torch datasets scikit-learn accelerate

# 3. Train the base model (run once, takes 20-40 min on CPU)
python train.py

# 4. Start ML inference server (keep open)
python predict_server.py

# 5. Start API server
node server.js

# 6. Run demo
node test_demo.js

# 7. Trigger fine-tuning when buffer is ready
curl -X POST http://localhost:8000/admin/finetune
# On Windows PowerShell:
curl.exe -X POST http://localhost:8000/admin/finetune
```

**Note:** Stop `predict_server.py` before triggering fine-tuning on Windows. The model file is memory-mapped and Windows holds a file lock that blocks the save. Restart it after fine-tuning completes.

---

## Demo Output

```
╔══════════════════════════════════════════╗
║            FULL SYSTEM DEMO              ║
╚══════════════════════════════════════════╝

--- STEP 3: Phishing Email — ML Only ---
Label: SAFE | Final: 0.0053 | ML: 0.0053 | Redis: 0
⚠  ML alone FAILS on this sophisticated social engineering email

--- STEP 4A: BOTNET — 12 Rapid Votes (50ms gap) ---
  Vote  1: R = 0.1648  [W_time penalized]
  Vote 12: R = 0.4918  ← capped, never reaches threshold

--- STEP 4B: REAL USERS — 12 Votes, 30-Min Gaps ---
  Vote  1: R = 0.7407
  Vote  2: R = 0.8951
  Vote  3: R = 0.9428  ★ threshold crossed
  Vote  5: R = 0.9955  ◄ added to finetune buffer

▶ EMAIL CLASSIFICATION
| Phishing(ML)    | 0.0053 | 0.0000 | 0.0053 | SAFE     |
| Phishing(Crowd) | 0.0053 | 0.9988 | 0.9977 | PHISHING |

▶ W_TIME ABUSE RESISTANCE
  Botnet  (50ms gaps) → capped at 0.4918
  Human   (30m gaps)  → reached  0.9988
  Difference: +0.5070 in favour of real users

  The crowd caught what the model missed.
```

---

## What Is Not Implemented (and Why)

These are known production requirements documented during development but intentionally excluded from the prototype scope.

### Message Queue for Fine-Tune Triggering

Currently fine-tuning is triggered by a manual `POST /admin/finetune` call. In production this should be replaced with a message queue (Apache Kafka or RabbitMQ).

**How it would work:**
- Each confirmed sample appended to the buffer also publishes a message to a Kafka topic `phish.confirmed`
- A dedicated worker consumes the topic and maintains a counter
- When the counter reaches 150, the worker enqueues a fine-tune job
- A GPU worker picks up the job, runs training, posts results back via webhook
- The API server receives the webhook and evicts the Redis keys

This decouples the report ingestion rate from the training trigger, allows spikes in reports to be absorbed without blocking the API, and enables the fine-tune worker to scale independently from the API tier.

### Redis Cluster

A single Redis instance is a single point of failure. Production would use Redis Cluster with replication — typically 3 primary nodes with 1 replica each. This provides horizontal scaling for write throughput and automatic failover if a primary node dies.

The application code would change minimally — `ioredis` supports cluster mode with a configuration change. The IoC hash keys would be distributed across nodes automatically.

### GPU Inference

DistilBERT inference on CPU takes ~200ms per request. On a GPU (T4 or equivalent) this drops to 15-30ms, making the full synchronous path comparable to the Redis lookup path. Processing millions of emails per day requires GPU infrastructure. The current CPU prototype is sufficient for demonstrating correctness.

### Federated Learning

The current fine-tuning pipeline requires confirmed email text to be transmitted to a central server. This cannot be deployed in regulated environments (healthcare, finance, government) where email content is protected.

Federated Learning via the FedAvg algorithm would solve this:

```
w_global = Σ (n_k/n) · w_local_k
```

Each organization trains locally on their own confirmed samples and returns only weight updates — never raw email text. The central server averages the updates and distributes the improved global model. A hospital fine-tuning on healthcare-themed phishing would improve protection for a bank facing similar campaigns, without either party accessing the other's data.

### Adversarial Training

The ML classifier is vulnerable to synonym substitution attacks — replacing "urgent" with "time-sensitive", inserting zero-width characters between letters, using Cyrillic characters that look identical to Latin ones. These preserve meaning for human readers but corrupt the feature vectors the model uses for detection.

Adversarial training (Madry et al.) would harden the model by generating adversarial examples during each fine-tuning cycle and including them in the training batch. The model learns to recognize both the original and the perturbed versions of phishing patterns.

### Periodic Full Retraining

Incremental fine-tuning causes weight drift over many cycles. After 20+ fine-tune rounds, the model may lose calibration on the original training distribution. The archived `confirmed_phishing.jsonl` files from each cycle form a growing dataset. Quarterly full retraining on the original 18,650 emails plus all archived confirmed samples would reset the model to a well-calibrated baseline that incorporates all observed historical and contemporary phishing patterns.

### Chrome Extension Frontend

The browser extension described in the research paper was excluded from the prototype to focus on the backend architecture. It would use the MutationObserver API to detect when Gmail or Outlook Web renders a new email, extract the sender and URLs, call `/predict`, and inject a color-coded warning banner into the email client. The `/report` endpoint handles user feedback from the banner buttons.

---

## Architectural Decisions

**Why Node.js for the API and Python only for ML?**
HuggingFace Transformers has no mature Node.js equivalent. Keeping Python isolated to two files (inference server and fine-tune script) means all routing, Redis operations, scoring math, and orchestration logic is in JavaScript — the language where the most development time was invested. The two components communicate over HTTP, which is standard microservice practice.

**Why DistilBERT instead of full BERT?**
40% fewer parameters, 60% faster inference, 97% of BERT's accuracy on most benchmarks. The accuracy tradeoff is negligible for this use case. On CPU hardware the speed difference is the difference between a usable and an unusable inference server.

**Why Redis and not a database?**
Threat reputation signals are volatile — most IoCs are relevant for hours or days, not permanently. Redis TTL handles automatic expiry without a cleanup job. O(1) hash lookups are essential at inference time. Pipeline operations ensure atomic multi-field updates. A relational database would introduce disk I/O latency that is unacceptable when this lookup is on the critical path of every prediction request.

**Why is fine-tuning a manual trigger and not automatic?**
Automatic triggering creates unpredictable load on the server. Manual trigger allows review of buffer contents before training, scheduling during low-traffic periods, and control over training frequency. In a production system this would be a scheduled cron job or a queue-triggered worker — not a random trigger during peak traffic.

**Why is the learning rate lower for incremental fine-tuning?**
The initial training used lr=2e-5. Incremental fine-tuning uses lr=1e-5. Smaller weight updates on new data reduce the risk of catastrophic forgetting — the phenomenon where aggressive updates on a small new batch overwrite representations learned from the original 18,650 emails. The model adapts incrementally rather than dramatically.

**Why delay Redis eviction until after fine-tuning succeeds?**
Between R crossing 0.90 and fine-tuning completing, new users are still opening the same phishing email. The Redis score is their only protection — the ML model has not yet learned the pattern. Deleting the key early creates a gap in coverage. Conditioning eviction on a successful fine-tune guarantees no user is left without a warning by an intermediate system state.

---

## Known Limitations

**Cold start:** No crowd signal exists for an IoC until the first user reports it. Against highly targeted attacks with few recipients, consensus may never form.

**User trust bootstrapping:** In a fresh deployment all users start at the same default trust level. The three-factor weighting reduces to a two-factor formula until historical accuracy data accumulates.

**Windows file locking:** On Windows, Python's memory-mapped model files cannot be overwritten while the inference server is running. The current workaround renames the locked file before saving. Production Linux deployments do not have this issue.

**CPU inference latency:** 200ms on consumer CPU hardware. Acceptable for a prototype, requires GPU for production scale.



---

*Built as part of DSE3270 Project Based Learning-4, Department of Computer Science and Engineering, Manipal University Jaipur.*
