import Redis from "ioredis";
import dotenv from "dotenv";

dotenv.config();

export const redis = new Redis({
  host: process.env.REDIS_HOST || "localhost",
  port: parseInt(process.env.REDIS_PORT || "6379", 10),
});

const ALPHA = parseFloat(process.env.ALPHA || "0.1");
const MU = parseFloat(process.env.MU || "0.005");
const ETA = parseFloat(process.env.ETA || "0.4");
const KAPPA = parseFloat(process.env.KAPPA || "1.5");

export const pingRedis = () => redis.ping();

export const initIoc = async (iocHash) => {
  const key = `phish:hash:${iocHash}`;
  const exists = await redis.exists(key);
  if (!exists) {
    const now = Date.now() / 1000;
    await redis.hset(key, {
      report_count: "0",
      emergence_time: now.toString(),
      last_report_time: now.toString(),
      raw_accumulation: "0",
      bounded_score: "0",
      added_to_buffer: "0",
    });
    await redis.expire(key, 259200); // 72 hours
  }
};

export const getScore = async (iocHash) => {
  const value = await redis.hget(`phish:hash:${iocHash}`, "bounded_score");
  return value ? parseFloat(value) : 0.0;
};

export const recordVote = async (iocHash, userTrust = 0.8, isPhishing = true) => {
  const key = `phish:hash:${iocHash}`;
  const data = await redis.hgetall(key);
  
  if (Object.keys(data).length === 0) {
    await initIoc(iocHash);
    return recordVote(iocHash, userTrust, isPhishing);
  }

  const lastReportTime = parseFloat(data.last_report_time || (Date.now() / 1000));
  const rawAccumulation = parseFloat(data.raw_accumulation || 0);
  let N = parseInt(data.report_count || 0, 10);
  
  N += 1;
  
  const now = Date.now() / 1000;
  const deltaT = now - lastReportTime;
  const wTime = ALPHA + (1 - ALPHA) * (1 - Math.exp(-MU * deltaT));
  
  const wDiminish = Math.exp(-ETA * (N - 1));
  
  let deltaZ = userTrust * wTime * wDiminish;
  if (!isPhishing) {
    deltaZ = -deltaZ * 0.5;
  }
  
  const newZ = Math.max(0, rawAccumulation + deltaZ);
  const R = 1 - Math.exp(-KAPPA * newZ);
  
  const pipe = redis.pipeline();
  pipe.hset(key, {
    report_count: N.toString(),
    last_report_time: now.toString(),
    raw_accumulation: newZ.toString(),
    bounded_score: R.toString(),
  });
  await pipe.exec();
  
  return { R, N, wTime, wDiminish, deltaZ };
};

export const getAllActiveIocs = async () => {
  const keys = await redis.keys("phish:hash:*");
  const result = [];
  for (const key of keys) {
    const data = await redis.hgetall(key);
    result.push({
      ioc_hash: key.split("phish:hash:")[1],
      report_count: parseInt(data.report_count || 0, 10),
      emergence_time: parseFloat(data.emergence_time || 0),
      last_report_time: parseFloat(data.last_report_time || 0),
      raw_accumulation: parseFloat(data.raw_accumulation || 0),
      bounded_score: parseFloat(data.bounded_score || 0),
    });
  }
  return result;
};

export const deleteIoc = async (iocHash) => {
  await redis.del(`phish:hash:${iocHash}`);
};
