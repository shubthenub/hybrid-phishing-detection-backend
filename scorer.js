import { getScore } from "./redis_engine.js";

export const getFinalScore = async (iocHash, mlScore) => {
  const rRedis = await getScore(iocHash);
  
  const raw = (1 - rRedis) * mlScore + rRedis * rRedis;
  const final = Math.min(1.0, Math.max(0.0, raw));
  
  let label = "PHISHING";
  if (final < 0.3) label = "SAFE";
  else if (final < 0.7) label = "SUSPICIOUS";
  
  return {
    finalScore: parseFloat(final.toFixed(4)),
    mlScore: parseFloat(mlScore.toFixed(4)),
    redisScore: parseFloat(rRedis.toFixed(4)),
    label,
    mlWeight: parseFloat((1 - rRedis).toFixed(4)),
    crowdWeight: parseFloat(rRedis.toFixed(4))
  };
};
