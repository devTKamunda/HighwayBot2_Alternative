// performanceController/analyzePerformance.js
import "dotenv/config";
import axios from "axios";
import OpenAI from "openai";
import connection from "../db.js";
import { markAsRead } from "../messagesController/markAsRead.js";
import { sendOneMessageButtonFunction } from "../messagesController/sendButtons.js";
import { sendMainMenuList } from "../messagesController/interactiveLists.js";

const GEMINI_OPENAI_BASE_URL =
  "https://generativelanguage.googleapis.com/v1beta/openai/";

const DEFAULT_PRIMARY_MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";
const BASE_MODELS = [DEFAULT_PRIMARY_MODEL, "gemini-3.8-flash", "gemini-3.5-flash-lite"];

// Remembers the last model that succeeded so subsequent runs start with a performing model
let preferredModel = DEFAULT_PRIMARY_MODEL;

let geminiOpenAIClient;
function getGeminiOpenAIClient() {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY is missing or empty. Set it in your .env file."
    );
  }
  if (!geminiOpenAIClient) {
    geminiOpenAIClient = new OpenAI({
      apiKey,
      baseURL: GEMINI_OPENAI_BASE_URL,
    });
  }
  return geminiOpenAIClient;
}

function toSeconds(rawTime) {
  const num = Number(rawTime) || 0;
  if (num <= 0) return 0;
  return num > 10000 ? Math.round(num / 1000) : Math.round(num);
}

function splitWhatsAppText(text, maxLen = 4000) {
  const clean = String(text ?? "").trim();
  if (!clean) return [];
  if (clean.length <= maxLen) return [clean];

  const chunks = [];
  let remaining = clean;

  while (remaining.length > maxLen) {
    let splitAt = remaining.lastIndexOf("\n", maxLen);
    if (splitAt <= 0) {
      splitAt = remaining.lastIndexOf(" ", maxLen);
    }
    if (splitAt <= 0) {
      splitAt = maxLen;
    }

    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}

async function sendMessageFunction(
  businessPhoneNumberId,
  user,
  messageId,
  messageData
) {
  const chunks = splitWhatsAppText(messageData);

  if (!businessPhoneNumberId || !user || chunks.length === 0) {
    console.error("Error sending other messages: Missing required parameters or empty body.");
    return;
  }

  for (let i = 0; i < chunks.length; i++) {
    const payload = {
      messaging_product: "whatsapp",
      to: String(user).trim(),
      text: { body: chunks[i] },
      ...(i === 0 && messageId
        ? { context: { message_id: String(messageId).trim() } }
        : {}),
    };

    try {
      await axios({
        method: "POST",
        url: `https://graph.facebook.com/v26.0/${businessPhoneNumberId}/messages`,
        headers: {
          Authorization: `Bearer ${process.env.GRAPH_API_TOKEN}`,
          "Content-Type": "application/json",
        },
        data: payload,
      });
    } catch (error) {
      console.error(
        "Error sending other messages:",
        JSON.stringify(error.response?.data || error.message)
      );
    }
  }
}

async function generateReportWithFallback(client, prompt) {
  const candidateModels = [
    ...new Set([preferredModel, ...BASE_MODELS].filter(Boolean)),
  ];
  let lastError;

  for (const candidateModel of candidateModels) {
    const maxAttempts = 2;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const completion = await client.chat.completions.create({
          model: candidateModel,
          messages: [
            {
              role: "system",
              content:
                "You are an expert driving test instructor that responds short and precisely.",
            },
            {
              role: "user",
              content: prompt,
            },
          ],
        });

        const text = (completion.choices?.[0]?.message?.content || "").trim();
        if (text) {
          // Move the winning model to index 0 so future runs start with it
          preferredModel = candidateModel;
          const idx = BASE_MODELS.indexOf(candidateModel);
          if (idx > 0) {
            BASE_MODELS.splice(idx, 1);
            BASE_MODELS.unshift(candidateModel);
          }
          return text;
        }
        lastError = new Error(`Model ${candidateModel} returned an empty response.`);
      } catch (error) {
        lastError = error;
        const status = error?.status || error?.response?.status;
        const isTransient = status === 503 || status === 429 || status === 500;
        console.warn(
          `[PerformanceAnalysis] Model=${candidateModel} attempt=${attempt} failed:`,
          error.message
        );
        if (!isTransient) {
          throw error;
        }
        // On 429 rate limits, move on to the next model immediately instead of burning retries
        if (status === 429) {
          break;
        }
        if (attempt < maxAttempts) {
          const delayMs = status === 503 ? 1500 * attempt : 1000 * attempt;
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }
    }
  }

  throw lastError || new Error("All models failed to generate a report.");
}

export async function analyzeUserPerformance(businessPhoneNumberId, user, messageId) {
  try {
    if (!businessPhoneNumberId || businessPhoneNumberId === user) {
      console.error("Invalid businessPhoneNumberId passed to analyzeUserPerformance:", {
        user,
        businessPhoneNumberId,
      });
      return;
    }

    const today = new Date().toISOString().split("T")[0];

    const [userResult] = await connection.execute(
      `SELECT performance_logs FROM users WHERE phone = ?`,
      [user]
    );

    let logEntry = userResult[0]?.performance_logs || "";
    let [logDate, logCount] = logEntry.split(":");

    const MAX_DAILY_ANALYSIS = 3;
    logCount = parseInt(logCount || "0", 10);

    if (logDate === today && logCount >= MAX_DAILY_ANALYSIS) {
      const label = "Main Menu";
      const buttonId = "main_menu";
      const text =
        "⚠️ You have exceeded your performance analysis limit for the day. You can only analyze performance 3 times per day.";

      await markAsRead(businessPhoneNumberId, messageId);
      await sendOneMessageButtonFunction(businessPhoneNumberId, user, text, label, buttonId);
      console.log("Performance Analysis not sent. User reached daily limit:", user);
      return;
    }

    const newCount = logDate === today ? logCount + 1 : 1;
    const remaining = MAX_DAILY_ANALYSIS - newCount;
    const newLog = `${today}:${newCount}`;

    // Single wait message sent once before analysis and silent retries
    await sendMessageFunction(
      businessPhoneNumberId,
      user,
      messageId,
      `🔍 Please wait while we analyze your performance... \n\n(Daily Performance Analyses left today: ${remaining})`
    );

    const [performanceData] = await connection.execute(
      `SELECT * FROM performance WHERE user_phone = ? ORDER BY test_number DESC`,
      [user]
    );

    if (performanceData.length === 0) {
      await sendMessageFunction(
        businessPhoneNumberId,
        user,
        messageId,
        "No performance data available."
      );
      return;
    }

    let totalTests = 0;
    let totalQuestions = 0;
    let totalCorrect = 0;
    let totalTimeSec = 0;
    const timedTests = [];

    const questionTypeStats = {
      road_sign_qtn_mark: { correct: 0, total: 0 },
      traffic_intersection_qtn_mark: { correct: 0, total: 0 },
      theory_qtn_mark: { correct: 0, total: 0 },
    };

    for (const test of performanceData) {
      const qTaken = Number(test.no_questions_taken) || 0;
      const qCorrect = Number(test.no_correct_answers) || 0;

      totalTests++;
      totalQuestions += qTaken;
      totalCorrect += qCorrect;

      for (const type of Object.keys(questionTypeStats)) {
        const value = typeof test[type] === "string" ? test[type] : "0/0";
        const parts = value.split("/");
        const correct = parseInt(parts[0], 10);
        const total = parseInt(parts[1], 10);

        questionTypeStats[type].correct += Number.isNaN(correct) ? 0 : correct;
        questionTypeStats[type].total += Number.isNaN(total) ? 0 : total;
      }

      if (test.status === "complete" && test.time_taken != null) {
        const secs = toSeconds(test.time_taken);
        timedTests.push({ ...test, _timeSec: secs });
        totalTimeSec += secs;
      }
    }

    const avgTimeSec = timedTests.length ? totalTimeSec / timedTests.length : 0;
    const avgMins = Math.floor(avgTimeSec / 60);
    const avgSecs = Math.round(avgTimeSec % 60);
    const avgTimeTaken = `⏳ ${avgMins} minutes ${avgSecs} seconds`;
    const passRate =
      totalQuestions > 0 ? ((totalCorrect / totalQuestions) * 100).toFixed(1) : "0.0";
    const overallRating = Number(passRate) >= 92 ? "✅Pass" : "❌Fail";

    const recentTimed = timedTests.slice(0, 5).map((t) => {
      const qTaken = Number(t.no_questions_taken) || 0;
      const qCorrect = Number(t.no_correct_answers) || 0;
      const scorePercent =
        qTaken > 0 ? ((qCorrect / qTaken) * 100).toFixed(1) : "0.0";
      const result = Number(scorePercent) >= 92 ? "✅Pass" : "❌Fail";
      const mins = Math.floor(t._timeSec / 60);
      const secs = t._timeSec % 60;
      return `Test ${t.test_number} | ⏳ ${mins}m ${secs}s, Score: ${scorePercent}%, ${result}`;
    });

    const questionTypeEntries = Object.entries(questionTypeStats).map(([type, data]) => ({
      type,
      correct: data.correct,
      total: data.total,
      percent: data.total ? ((data.correct / data.total) * 100).toFixed(1) : "0.0",
    }));

    const sortedAreas = [...questionTypeEntries].sort(
      (a, b) => Number(a.percent) - Number(b.percent)
    );
    const worstAreas = sortedAreas.slice(0, 2);
    const bestAreas = sortedAreas.slice(-2).reverse();

    const readableType = {
      road_sign_qtn_mark: "Road Signs",
      traffic_intersection_qtn_mark: "Traffic Intersections",
      theory_qtn_mark: "Theory",
    };

    const compactData = `
*Overall Performance*
No. of tests completed : ${totalTests}
Total attempted questions : ${totalQuestions}
Total correct answers : ${totalCorrect}/${totalQuestions}
Pass rate : ${passRate}% ${overallRating}
Average test completion time: ${avgTimeTaken}

*Timed Test Performance History*
${recentTimed.join("\n")}

*Worst & Best Test Performance Areas*
1. Worst
${worstAreas.map((a) => `${readableType[a.type]} :${a.correct} correct out of ${a.total} -${a.percent}%`).join("\n")}

2. Best 
${bestAreas.map((a) => `${readableType[a.type]} :${a.correct} correct out of ${a.total} -${a.percent}%`).join("\n")}
`;

    console.log(compactData);

    const prompt = `
Analyze the following provisional driving license test performance data & give a very helpful report:
This data is from a Whatsapp Chatbot called Zim Provisional Driver's License Whatsapp Assistant designed to help people get ready to ace their Learner's Driver's License test.

${compactData}

The report should be formatted as follows:

*Your Performance Progress Report*
*Overal Perfomace*
No of tests completed : XXX 
Total attempted questions : XXX 
Total correct answers : XXX/XXX 
Pass rate : XXX% <ratting (✅Pass/❌Fail)> 
Average test completion time taken: ⏳ XXX minutes XXX seconds

*Timed Test Performance History* 
Test <No> | ⏳ <time taken>, Score: XXX%, <ratting (✅Pass/❌Fail)> 

*Worst & Best Test Performance Areas*
1. Worst
        <question_type> : XXX correct out of XXX total number of attempts - XXX%
2. Best 
        <question_type> : XXX correct out of XXX total number of attempts - XXX%
            
*Areas & Suggestions for Improvement*
<question_type> : (comment and suggestion)

*Recommended Practice Strategies*
//list your recommended strategies. Always state the Zim Provisional Driver's Whatsapp Assistant as the only study tool

*Performance Progress Summary*
(analyze the performance trend and summarize progress and readiness)
    
- please note that pass is 92% or 23/25 and above.
- Always refer all recommendations to this Zim Provisional Driver's Whatsapp Chatbot
- include icons
- please do not add more *s or #s apart from the ones in format
`;

    const client = getGeminiOpenAIClient();
    const messageData = await generateReportWithFallback(client, prompt);
    const text = "Select *Menu* for the main menu.";

    await markAsRead(businessPhoneNumberId, messageId);
    await sendMessageFunction(businessPhoneNumberId, user, messageId, messageData+"\n\nType *Menu* to return to the main menu.");
    await sendMainMenuList(businessPhoneNumberId, user, text);

    await connection.execute(
      `UPDATE users SET performance_logs = ? WHERE phone = ?`,
      [newLog, user]
    );

    console.log("Performance Analysis sent to user:", user);
  } catch (error) {
    console.error("Error analyzing performance:", error.message);
    await sendMessageFunction(
      businessPhoneNumberId,
      user,
      messageId,
      "Something went wrong while analyzing your performance. Try again."
    );
  }
}
