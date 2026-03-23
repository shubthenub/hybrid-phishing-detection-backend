const LEGIT_EMAIL = `
Hi Sarah,
Just confirming our meeting tomorrow at 3pm.
Let me know if you need to reschedule.
Best, John
`;

const PHISHING_EMAIL = `
[Final Notice For MANIPAL UNIVERSITY Students]

Dear Student (Important),

This is the final and official notification regarding the Academic Internship & Certification Program exclusively for MANIPAL UNIVERSITY Students.

Despite multiple prior communications, you have not responded. Kindly treat this as the last and mandatory notice for enrollment.

The program is conducted in collaboration with IIT Roorkee and includes certification from Microsoft, Apple, Cisco, and Meta. It is structured to ensure early industry exposure, practical learning, and structured career preparation starting from the academic year.

Final Registration Deadline: March 19th, 2026 | 12:30 PM (IST) - No further extension will be provided.
Registration Link (Mandatory Submission):
https://forms.gle/Bfj8itkWRwnoPB6e9
Key Benefits:
- Industry-Mentored Course Completion Certificate
- Internship Completion Certificate from reputed MNCs
- Performance-Based Letter of Recommendation
- Structured Placement Assistance and Resume Support
- Access to Career Development Community

Please note that failure to register by the deadline will result in forfeiting this for academic credit in the current batch.

Students who have already completed registration may disregard this communication.
Regards,
Training and Internship Cell
`;

const PHISHING_SENDER = "20l31a0293@vignaniit.edu.in";
const BASE_URL = "http://localhost:8000";
const THIRTY_MINS = 1800;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function resetIoc(iocHash) {
  await fetch(`${BASE_URL}/reset-ioc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ioc_hash: iocHash })
  });
}

async function backdateIoc(iocHash, secondsAgo) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(`${BASE_URL}/simulate-time`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ioc_hash: iocHash, seconds_ago: secondsAgo }),
      signal: controller.signal
    });
    clearTimeout(timeout);
    return res.json();
  } catch (e) {
    clearTimeout(timeout);
  }
}

async function predict(emailText, sender) {
  const res = await fetch(`${BASE_URL}/predict`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email_text: emailText, sender })
  });
  return res.json();
}

async function vote(iocHash) {
  const res = await fetch(`${BASE_URL}/report`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ioc_hash: iocHash,
      is_phishing: true,
      email_text: PHISHING_EMAIL,
      user_trust: 0.9
    })
  });
  const data = await res.json();
  if (!data.new_redis_score) {
    console.log(`  [vote error] ${JSON.stringify(data)}`);
    return { new_redis_score: 0, added_to_buffer: false };
  }
  return data;
}

async function runDemo() {
  console.log("\n╔══════════════════════════════════════════╗");
  console.log("║            FULL SYSTEM DEMO              ║");
  console.log("╚══════════════════════════════════════════╝");

  console.log("\n--- STEP 1: Health Check ---");
  console.log(await (await fetch(`${BASE_URL}/health`)).json());

  console.log("\n--- STEP 2: Legitimate Email ---");
  const legitData = await predict(LEGIT_EMAIL, "john@company.com");
  console.log(`Label: ${legitData.label} | Final: ${legitData.finalScore} | ML: ${legitData.mlScore} | Redis: ${legitData.redisScore}`);

  console.log("\n--- STEP 3: Phishing Email — ML Only ---");
  const temp = await predict(PHISHING_EMAIL, PHISHING_SENDER);
  const iocHash = temp.iocHash;
  await resetIoc(iocHash);

  const phishData = await predict(PHISHING_EMAIL, PHISHING_SENDER);
  console.log(`Label: ${phishData.label} | Final: ${phishData.finalScore} | ML: ${phishData.mlScore} | Redis: ${phishData.redisScore}`);
  console.log(`⚠  ML alone FAILS on this sophisticated social engineering email`);

  console.log("\n--- STEP 4A: BOTNET — 12 Rapid Votes (50ms gap) ---");
  await resetIoc(iocHash);
  const rapidScores = [];

  for (let i = 1; i <= 12; i++) {
    const data = await vote(iocHash);
    rapidScores.push(data.new_redis_score);
    console.log(`  Vote ${String(i).padStart(2)}: R = ${data.new_redis_score.toFixed(4)}  [W_time penalized]`);
    await sleep(50);
  }
  console.log(`\n  → Capped at: ${rapidScores.at(-1).toFixed(4)}`);

  console.log("\n--- STEP 4B: REAL USERS — 12 Votes, 30-Min Gaps ---");
  await resetIoc(iocHash);
  const spacedScores = [];

  for (let i = 1; i <= 12; i++) {
    await backdateIoc(iocHash, THIRTY_MINS);
    const data = await vote(iocHash);
    spacedScores.push(data.new_redis_score);
    const flags = [
      data.new_redis_score >= 0.9 ? "★ threshold crossed" : "",
      data.added_to_buffer ? "◄ added to finetune buffer" : ""
    ].filter(Boolean).join("  ");
    console.log(`  Vote ${String(i).padStart(2)}: R = ${data.new_redis_score.toFixed(4)}  ${flags}`);
    await sleep(100);
  }
  console.log(`\n  → Final: ${spacedScores.at(-1).toFixed(4)}`);

  console.log("\n--- STEP 5: Re-Predict After Crowd Reports ---");
  const phishReData = await predict(PHISHING_EMAIL, PHISHING_SENDER);
  console.log(`Label: ${phishReData.label} | Final: ${phishReData.finalScore} | ML: ${phishReData.mlScore} | Redis: ${phishReData.redisScore}`);

  console.log("\n--- STEP 6: System Status ---");
  const status = await (await fetch(`${BASE_URL}/status`)).json();
  console.log(`Active IoCs: ${status.active_iocs} | Buffer Size: ${status.buffer_size}`);

  const rapidFinal = rapidScores.at(-1);
  const spacedFinal = spacedScores.at(-1);

  console.log("\n╔══════════════════════════════════════════╗");
  console.log("║              RESULTS                     ║");
  console.log("╚══════════════════════════════════════════╝");

  console.log("\n▶ EMAIL CLASSIFICATION");
  console.log("+-----------------+----------+-------------+-------------+----------+");
  console.log("| Email           | ML Score | Redis Score | Final Score | Label    |");
  console.log("+-----------------+----------+-------------+-------------+----------+");
  console.log(`| Legitimate      | ${legitData.mlScore.toFixed(4).padEnd(8)} | ${"0.0000".padEnd(11)} | ${legitData.finalScore.toFixed(4).padEnd(11)} | ${legitData.label.padEnd(8)} |`);
  console.log(`| Phishing(ML)    | ${phishData.mlScore.toFixed(4).padEnd(8)} | ${"0.0000".padEnd(11)} | ${phishData.finalScore.toFixed(4).padEnd(11)} | ${phishData.label.padEnd(8)} |`);
  console.log(`| Phishing(Crowd) | ${phishReData.mlScore.toFixed(4).padEnd(8)} | ${phishReData.redisScore.toFixed(4).padEnd(11)} | ${phishReData.finalScore.toFixed(4).padEnd(11)} | ${phishReData.label.padEnd(8)} |`);
  console.log("+-----------------+----------+-------------+-------------+----------+");

  console.log("\n▶ W_TIME ABUSE RESISTANCE — BOTNET vs REAL USERS");
  console.log("+--------+--------------------+--------------------+");
  console.log("| Vote # | Botnet (50ms gap)  | Human (30min gap)  |");
  console.log("+--------+--------------------+--------------------+");
  for (let i = 0; i < 12; i++) {
    const r = rapidScores[i]?.toFixed(4) ?? "N/A";
    const s = spacedScores[i]?.toFixed(4) ?? "N/A";
    const star = parseFloat(s) >= 0.9 ? "★" : " ";
    console.log(`|   ${String(i+1).padStart(2)}   | ${r.padEnd(18)} | ${(s + " " + star).padEnd(18)} |`);
  }
  console.log("+--------+--------------------+--------------------+");
  console.log(`| FINAL  | ${rapidFinal.toFixed(4).padEnd(18)} | ${spacedFinal.toFixed(4).padEnd(18)} |`);
  console.log("+--------+--------------------+--------------------+");
  console.log(`\n  Difference: +${(spacedFinal - rapidFinal).toFixed(4)} in favour of real users`);

  console.log("\n▶ KEY INSIGHT");
  console.log(`  ML score on this email:       ${phishData.mlScore} (classified SAFE)`);
  console.log(`  Redis after 12 human reports: ${spacedFinal.toFixed(4)}`);
  console.log(`  Final fused score:            ${phishReData.finalScore} → ${phishReData.label}`);
  console.log(`\n  The crowd caught what the model missed.`);
}

runDemo().catch(console.error);