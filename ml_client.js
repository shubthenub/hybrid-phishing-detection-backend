import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

export const getPrediction = async (text) => {
  try {
    const res = await fetch(process.env.ML_PREDICT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text })
    });
    if (!res.ok) {
        throw new Error(`HTTP error: status ${res.status}`);
    }
    const data = await res.json();
    return data.ml_score;
  } catch (err) {
    console.warn("[ML_CLIENT] predict_server.py is not running! Fallback to 0.5. Error:", err.message);
    return 0.5;
  }
};
