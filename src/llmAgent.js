import fs from "node:fs";
import path from "node:path";

const searchSkillPath = path.resolve("specs/music-time-agent.search.skill.md");

export async function planSearch({ config, slot, local, previousAttempts = [] }) {
  const apiKeyEnv = config.llm.apiKeyEnv || "MUSIC_LLM_API_KEY";
  const apiKey = process.env[apiKeyEnv];
  if (!apiKey) {
    throw new Error(`缺少 ${apiKeyEnv}，无法执行 LLM 驱动选歌。`);
  }
  const baseUrl = (config.llm.baseUrl || process.env.MUSIC_LLM_BASE_URL || "").replace(/\/+$/, "");
  if (!baseUrl) {
    throw new Error("缺少 MUSIC_LLM_BASE_URL 或 config.llm.baseUrl，无法执行 LLM 驱动选歌。");
  }
  const model = config.llm.model || process.env.MUSIC_LLM_MODEL || "";
  if (!model) {
    throw new Error("缺少 MUSIC_LLM_MODEL 或 config.llm.model，无法执行 LLM 驱动选歌。");
  }
  const searchSkill = fs.readFileSync(searchSkillPath, "utf8");

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "system",
          content: [
            "你是网易云音乐时段播放 agent。只输出 JSON，不输出解释。",
            "不得硬编码固定歌曲；必须根据当前时间、时段氛围和当前时段关键词生成网易云搜索关键词。",
            "必须先根据当前时段关键词、反向关键词、氛围和时间生成用户在该时段的个性化音乐画像，再基于画像制定搜索策略。",
            "时段关键词是偏好证据，不是直接搜索词来源；禁止不经画像和策略直接照抄 slot_keywords。",
            "反向关键词是排除和禁止信号：不得出现在 keyword 或 alternate_keywords 中，也不得生成语义上明显接近的搜索方向。",
            "时段氛围只用于判断播放方向和筛选偏好，禁止把抽象氛围词直接拼进搜索关键词。",
            "搜索关键词必须短、像真实用户会在网易云搜索框输入的词，优先使用画像推导出的音乐风格、歌手类型、语种或场景词。",
            "避免使用 唤醒、恢复、不要、低 BPM、时段名称 这类控制/约束词作为搜索关键词。",
            "如果当前时段关键词为空，可以根据氛围生成宽泛音乐搜索词，但仍需保持 2-8 个汉字或 1-3 个短词。",
            "如果存在 previous_attempts，必须改变搜索策略并生成未失败过的新 keyword。",
            "",
            searchSkill
          ].join("\n")
        },
        {
          role: "user",
          content: JSON.stringify({
            now: local.isoLocal,
            timezone: config.timezone,
            slot: {
              id: slot.id,
              start: slot.start,
              end: slot.end,
              intent: slot.intent
            },
            slot_keywords: Array.isArray(slot.keywords) ? slot.keywords : [],
            slot_negative_keywords: Array.isArray(slot.negativeKeywords) ? slot.negativeKeywords : [],
            previous_attempts: previousAttempts,
            output_schema: {
              user_profile: "string, 根据当前时段关键词、反向关键词、氛围和时间推断出的个性化听歌画像；不能只是复述关键词",
              keyword: "string, 网易云搜索关键词；不要直接包含 slot.intent 中的抽象控制词",
              alternate_keywords: "array of 2-4 strings, 备用网易云搜索关键词；必须短而宽，不要直接包含 slot.intent 中的抽象控制词",
              search_strategy: "string, 本次搜索策略；必须说明如何从用户画像推导搜索方向；如果有失败历史，说明相对失败关键词做了什么改变",
              reason: "string, 简短理由",
              preferred_language: "string",
              avoid: "string, 必须包含反向关键词和其它应排除方向"
            }
          })
        }
      ],
      response_format: { type: "json_object" }
    })
  });

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`LLM 请求失败: HTTP ${response.status} ${raw.slice(0, 500)}`);
  }
  const payload = JSON.parse(raw);
  const text = payload.choices?.[0]?.message?.content;
  if (!text) throw new Error(`LLM 响应缺少 message.content: ${raw.slice(0, 500)}`);
  const parsed = JSON.parse(text);
  for (const key of ["user_profile", "keyword", "search_strategy", "reason", "preferred_language", "avoid"]) {
    if (typeof parsed[key] !== "string" || parsed[key].trim() === "") {
      throw new Error(`LLM 响应字段无效: ${key}`);
    }
  }
  const failedKeywords = new Set(previousAttempts.map((attempt) => attempt.keyword).filter(Boolean));
  const positiveKeywords = Array.isArray(slot.keywords) ? slot.keywords.map((item) => item.trim()).filter(Boolean) : [];
  const negativeKeywords = Array.isArray(slot.negativeKeywords) ? slot.negativeKeywords.map((item) => item.trim()).filter(Boolean) : [];
  if (!Array.isArray(parsed.alternate_keywords)) parsed.alternate_keywords = [];
  parsed.alternate_keywords = parsed.alternate_keywords
    .filter((keyword) => typeof keyword === "string" && keyword.trim() !== "" && !failedKeywords.has(keyword.trim()))
    .filter((keyword) => !containsNegativeKeyword(keyword, negativeKeywords))
    .filter((keyword) => !isCopiedPositiveKeyword(keyword, positiveKeywords))
    .slice(0, 4);
  if (failedKeywords.has(parsed.keyword.trim()) || containsNegativeKeyword(parsed.keyword, negativeKeywords) || isCopiedPositiveKeyword(parsed.keyword, positiveKeywords)) {
    const promoted = parsed.alternate_keywords.shift();
    if (!promoted) {
      throw new Error(`LLM 搜索词未通过约束: ${parsed.keyword}`);
    }
    parsed.keyword = promoted;
  }
  assertNoNegativeKeyword(parsed.keyword, negativeKeywords);
  return parsed;
}

function assertNoNegativeKeyword(keyword, negativeKeywords) {
  if (containsNegativeKeyword(keyword, negativeKeywords)) {
    throw new Error(`LLM 搜索词包含反向关键词: ${keyword}`);
  }
}

function containsNegativeKeyword(keyword, negativeKeywords) {
  return negativeKeywords.some((negative) => keyword.includes(negative));
}

function isCopiedPositiveKeyword(keyword, positiveKeywords) {
  const normalizedKeyword = normalizeKeyword(keyword);
  return positiveKeywords.some((positive) => normalizeKeyword(positive) === normalizedKeyword);
}

function normalizeKeyword(keyword) {
  return keyword.replace(/\s+/g, "").trim();
}
