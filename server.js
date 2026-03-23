import express from "express";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { 
  pingRedis, initIoc, getScore, recordVote, 
  getAllActiveIocs, deleteIoc, 
  redis
} from "./redis_engine.js";
import { extractIoc, cleanEmailText } from "./feature_extractor.js";
import { getFinalScore } from "./scorer.js";
import { getPrediction } from "./ml_client.js";

dotenv.config();
const FINETUNE_ARCHIVE_DIR = process.env.FINETUNE_ARCHIVE_DIR || "./data/archives";
const FINETUNE_RESULTS_DIR = process.env.FINETUNE_RESULTS_DIR || "./data/results";

// Create folders if they don't exist for archive and results
if (!fs.existsSync("./data")) fs.mkdirSync("./data");
if (!fs.existsSync(FINETUNE_ARCHIVE_DIR)) fs.mkdirSync(FINETUNE_ARCHIVE_DIR, { recursive: true });
if (!fs.existsSync(FINETUNE_RESULTS_DIR)) fs.mkdirSync(FINETUNE_RESULTS_DIR, { recursive: true });


const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8000;
const FINETUNE_TAU = parseFloat(process.env.FINETUNE_TAU || "0.90");
const MIN_REPORTS = parseInt(process.env.MIN_REPORTS || "5", 10);
const FINETUNE_BUFFER_PATH = process.env.FINETUNE_BUFFER_PATH || "./confirmed_phishing.jsonl";
const FINETUNE_MIN_SAMPLES = parseInt(process.env.FINETUNE_MIN_SAMPLES || "150", 10);

app.post("/predict", async (req, res) => {
  try {
    const { email_text = "", sender = "" } = req.body;
    const cleanText = cleanEmailText(email_text);
    const iocData = extractIoc(email_text, sender);
    
    await initIoc(iocData.iocHash);
    const mlScore = await getPrediction(cleanText);
    const scoreData = await getFinalScore(iocData.iocHash, mlScore);
    
    res.json({ ...iocData, ...scoreData });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const getBufferLines = () => {
    try {
        const content = fs.readFileSync(FINETUNE_BUFFER_PATH, "utf8");
        return content.split("\n").filter(line => line.trim().length > 0).length;
    } catch {
        return 0;
    }
}

app.post("/report", async (req, res) => {
  try {
    const { ioc_hash, is_phishing, email_text, user_trust = 0.8 } = req.body;

    if (!ioc_hash || typeof is_phishing === 'undefined') {
      return res.status(400).json({ error: "ioc_hash and is_phishing required" });
    }

    const { R, N } = await recordVote(ioc_hash, user_trust, is_phishing);
    let addedToBuffer = false;

    const alreadyBuffered = await redis.hget(`phish:hash:${ioc_hash}`, "added_to_buffer");

    if (R >= FINETUNE_TAU && N >= MIN_REPORTS && is_phishing && email_text && alreadyBuffered != "1") {
      const entry = {
        text: email_text,
        label: 1,
        ioc_hash,
        timestamp: Date.now()
      };
      fs.appendFileSync(FINETUNE_BUFFER_PATH, JSON.stringify(entry) + "\n");
      await redis.hset(`phish:hash:${ioc_hash}`, { added_to_buffer: "1" });
      addedToBuffer = true;
    }

    const buffer_size = getBufferLines();

    res.json({
      ioc_hash,
      new_redis_score: R,
      report_count: N,
      added_to_buffer: addedToBuffer,
      buffer_size,
      message: addedToBuffer ? "Threshold met. Added to fine-tune buffer." : "Vote recorded."
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/score/:iocHash", async (req, res) => {
  try {
    const redis_score = await getScore(req.params.iocHash);
    let label = "PHISHING";
    if (redis_score < 0.3) label = "SAFE";
    else if (redis_score < 0.7) label = "SUSPICIOUS";
    
    res.json({ ioc_hash: req.params.iocHash, redis_score, label });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/admin/finetune", async (req, res) => {
  try {
    const buffer_size = getBufferLines();
    if (buffer_size < FINETUNE_MIN_SAMPLES) {
      return res.json({ 
        status: "insufficient", 
        current: buffer_size, 
        needed: FINETUNE_MIN_SAMPLES 
      });
    }

    const pythonProcess = spawn("python", ["finetune.py", "--batch", FINETUNE_BUFFER_PATH]);
    
    pythonProcess.stdout.on("data", data => console.log(data.toString()));
    pythonProcess.stderr.on("data", data => console.error(data.toString()));
    
    pythonProcess.on("close", async (code) => {
      if (code === 0) {
        try {
          const timestamp = new Date().toISOString().replace(/[:.]/g, "-");

          // Read latest.json written by finetune.py
          const resultData = JSON.parse(
            fs.readFileSync(path.join(FINETUNE_RESULTS_DIR, "latest.json"), "utf8")
          );

          // Evict Redis keys
          for (const iocHash of resultData.ioc_hashes || []) {
            await deleteIoc(iocHash);
          }

          // Archive the buffer
          const archivePath = path.join(FINETUNE_ARCHIVE_DIR, `archive_${timestamp}.jsonl`);
          fs.renameSync(FINETUNE_BUFFER_PATH, archivePath);

          console.log("[FINETUNE] Finished successfully");
          console.log(`[FINETUNE] Buffer archived to ${archivePath}`);

          res.json({
            status: "success",
            samples_trained: resultData.samples_trained,
            iocs_evicted: (resultData.ioc_hashes || []).length,
            archived_to: archivePath,
            model_updated: true
          });

        } catch (e) {
          console.error("Error post-finetune:", e);
          if (!res.headersSent) res.status(500).json({ error: "Post-finetune processing failed" });
        }
      } else {
        if (!res.headersSent) res.json({ status: "failed", message: "Training failed. Redis keys preserved." });
      }
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/status", async (req, res) => {
  try {
    const active_iocs = await getAllActiveIocs();
    const buffer_size = getBufferLines();
    
    // Check ml server
    let ml_server_connected = false;
    try {
        const mlTest = await fetch(process.env.ML_PREDICT_URL, {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "test" })
        });
        if (mlTest.ok) ml_server_connected = true;
    } catch {}

    const ping = await pingRedis();
    
    res.json({
      active_iocs: active_iocs.length,
      ioc_list: active_iocs,
      buffer_size,
      buffer_needed: Math.max(0, FINETUNE_MIN_SAMPLES - buffer_size),
      redis_connected: ping === "PONG",
      ml_server_connected
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: Date.now() });
});

app.listen(PORT, async () => {
  console.log(`[SERVER] API listening on port ${PORT}`);
  try {
    await pingRedis();
    console.log("[SERVER] Redis connection verified.");
  } catch (err) {
    console.error("[SERVER] Redis connection failed:", err.message);
  }
  
  // Test ML server
  try {
      await getPrediction("Hello world");
      console.log("[SERVER] ML server is available.");
  } catch {
      console.warn("[SERVER] ML server not available yet.");
  }
});

//ye endpoints sirf testing ke liye hai.(TESTING PURPOSE ONLY)
app.post("/simulate-time", async (req, res) => {
  const { ioc_hash, seconds_ago } = req.body;
  const fakeTime = (Date.now() / 1000) - seconds_ago;
  await initIoc(ioc_hash);
  await redis.hset(`phish:hash:${ioc_hash}`, { last_report_time: fakeTime.toString() });
  res.json({ ok: true, backdated_by_seconds: seconds_ago });
});

app.post("/reset-ioc", async (req, res) => {
  const { ioc_hash } = req.body;
  await deleteIoc(ioc_hash);
  res.json({ ok: true, deleted: ioc_hash });
});