import fs from "node:fs";
import path from "node:path";

const searchSkillPath = path.resolve("specs/music-time-agent.search.skill.md");

export async function planSearch({ config, slot, local, previousAttempts = [] }) {
  const apiKeyEnv = config.llm.apiKeyEnv || "OPENAI_API_KEY";
  const apiKey = process.env[apiKeyEnv];
  if (!apiKey) {
    throw new Error(`缺少 ${apiKeyEnv}，无法执行 LLM 驱动选歌。`);
  }
  const baseUrl = (config.llm.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
  const searchSkill = fs.readFileSync(searchSkillPath, "utf8");

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: config.llm.model,
      messages: [
        {
          role: "system",
          content: [
            "你是网易云音乐时段播放 agent。只输出 JSON，不输出解释。",
            "不得硬编码固定歌曲；必须根据当前时间、时段氛围和当前时段关键词生成网易云搜索关键词。",
            "时段氛围只用于判断播放方向和筛选偏好，禁止把抽象氛围词直接拼进搜索关键词。",
            "搜索关键词必须短、像真实用户会在网易云搜索框输入的词，优先使用当前时段关键词中的音乐风格、歌手、语种或场景词。",
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
            previous_attempts: previousAttempts,
            output_schema: {
              keyword: "string, 网易云搜索关键词；不要直接包含 slot.intent 中的抽象控制词",
              alternate_keywords: "array of 2-4 strings, 备用网易云搜索关键词；必须短而宽，不要直接包含 slot.intent 中的抽象控制词",
              search_strategy: "string, 本次搜索策略；如果有失败历史，说明相对失败关键词做了什么改变",
              reason: "string, 简短理由",
              preferred_language: "string",
              avoid: "string"
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
  for (const key of ["keyword", "search_strategy", "reason", "preferred_language", "avoid"]) {
    if (typeof parsed[key] !== "string" || parsed[key].trim() === "") {
      throw new Error(`LLM 响应字段无效: ${key}`);
    }
  }
  const failedKeywords = new Set(previousAttempts.map((attempt) => attempt.keyword).filter(Boolean));
  if (failedKeywords.has(parsed.keyword.trim())) {
    throw new Error(`LLM 重复了已失败关键词: ${parsed.keyword}`);
  }
  if (!Array.isArray(parsed.alternate_keywords)) parsed.alternate_keywords = [];
  parsed.alternate_keywords = parsed.alternate_keywords
    .filter((keyword) => typeof keyword === "string" && keyword.trim() !== "" && !failedKeywords.has(keyword.trim()))
    .slice(0, 4);
  return parsed;
}
