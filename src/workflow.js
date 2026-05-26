import { currentSlot, millisecondsUntilNextSchedule } from "./timeSlots.js";
import { doctor, playSongQueue, runCli, searchSongs } from "./ncmCli.js";
import { planSearch } from "./llmAgent.js";
import { loadConfig } from "./config.js";

export async function runOnce(config) {
  const health = await doctor(config);
  if (!health.ok) {
    const detail = health.checks.map((check) => `${check.ok ? "OK" : "FAIL"} ${check.name}: ${check.detail}`).join("\n");
    throw new Error(`运行前检查失败:\n${detail}`);
  }

  const { slot, local } = currentSlot(config);
  let plan = null;
  let songs = [];
  let selectedKeyword = "";
  const searchAttempts = [];
  const maxAttempts = Number.isInteger(config.search?.maxAttempts) ? config.search.maxAttempts : Infinity;
  while (songs.length === 0) {
    if (searchAttempts.length >= maxAttempts) {
      throw new Error(`LLM 搜索策略重试已达上限 ${maxAttempts}，仍未找到可播放歌曲: ${JSON.stringify(searchAttempts)}`);
    }
    plan = await planSearch({ config, slot, local, previousAttempts: searchAttempts });
    const keywords = [...new Set([plan.keyword, ...(plan.alternate_keywords || [])].map((keyword) => keyword.trim()).filter(Boolean))];
    for (const keyword of keywords) {
      if (searchAttempts.some((attempt) => attempt.keyword === keyword)) continue;
      try {
        songs = await searchSongs(config, keyword);
        selectedKeyword = keyword;
        searchAttempts.push({
          keyword,
          strategy: plan.search_strategy,
          status: "matched"
        });
        break;
      } catch (error) {
        searchAttempts.push({
          keyword,
          strategy: plan.search_strategy,
          status: "failed",
          error: error.message
        });
      }
      if (searchAttempts.length >= maxAttempts) break;
    }
  }
  const playback = await playSongQueue(config, songs);
  return {
    status: "played",
    time: local.isoLocal,
    slot: slot.id,
    plan,
    searchAttempts,
    selectedKeyword,
    selected: playback.first,
    queue: {
      count: playback.queue.length,
      added: playback.added.length,
      order: playback.queue.map((song) => ({
        encryptedId: song.encryptedId,
        originalId: song.originalId,
        name: song.name,
        artist: song.artist
      }))
    }
  };
}

export async function runDaemon(config) {
  const loop = async () => {
    const activeConfig = loadConfig(config.__path);
    const next = millisecondsUntilNextSchedule(activeConfig);
    console.log(JSON.stringify({
      status: "waiting",
      next_slot: next.slot.id,
      next_time: next.hhmm,
      delay_ms: next.delayMs
    }));
    setTimeout(async () => {
      try {
        console.log(JSON.stringify(await runOnce(loadConfig(config.__path))));
      } catch (error) {
        console.error(JSON.stringify({ status: "failed", error: error.message }));
      } finally {
        loop();
      }
    }, next.delayMs);
  };
  await loop();
}

export async function stop(config) {
  await runCli(config.ncmCliBin, ["stop", "--output", "json"], { timeoutMs: 10000 });
  await runCli(config.ncmCliBin, ["queue", "clear", "--output", "json"], { timeoutMs: 10000 });
  return { status: "stopped" };
}

export async function pause(config) {
  await runCli(config.ncmCliBin, ["pause", "--output", "json"], { timeoutMs: 10000 });
  return { status: "paused" };
}

export async function state(config) {
  const result = await runCli(config.ncmCliBin, ["state", "--output", "json"], { timeoutMs: 10000 });
  return { status: "state", data: JSON.parse(result.stdout.trim()) };
}
