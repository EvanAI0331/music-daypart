function minutesOfDay(hhmm) {
  const match = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!match) throw new Error(`非法时间格式: ${hhmm}`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new Error(`非法时间值: ${hhmm}`);
  return hour * 60 + minute;
}

export function nowInTimezone(timezone, now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    isoLocal: `${value.year}-${value.month}-${value.day}T${value.hour}:${value.minute}:${value.second}`,
    minutes: Number(value.hour) * 60 + Number(value.minute),
    hhmm: `${value.hour}:${value.minute}`
  };
}

export function currentSlot(config, now = new Date()) {
  const local = nowInTimezone(config.timezone, now);
  const slot = enabledSlots(config).find((candidate) => inWindow(local.minutes, candidate.start, candidate.end));
  if (!slot) throw new Error(`当前时间 ${local.hhmm} 没有已启用的匹配时段`);
  return { slot, local };
}

export function rawCurrentSlot(config, now = new Date()) {
  const local = nowInTimezone(config.timezone, now);
  const slot = config.slots.find((candidate) => inWindow(local.minutes, candidate.start, candidate.end));
  if (!slot) throw new Error(`没有匹配当前时间 ${local.hhmm} 的时段`);
  return { slot, local };
}

function enabledSlots(config) {
  return config.slots.filter((slot) => slot.enabled !== false);
}

function inWindow(current, start, end) {
  const startMin = minutesOfDay(start);
  const endMin = minutesOfDay(end);
  if (startMin < endMin) return current >= startMin && current < endMin;
  return current >= startMin || current < endMin;
}

export function millisecondsUntilNextSchedule(config, now = new Date()) {
  const local = nowInTimezone(config.timezone, now);
  const today = local.minutes;
  const candidates = [];
  for (const slot of enabledSlots(config)) {
    for (const target of hourlyTargets(slot)) {
      const deltaMinutes = target > today ? target - today : 24 * 60 - today + target;
      candidates.push({ slot, hhmm: hhmmFromMinutes(target), delayMs: deltaMinutes * 60 * 1000 });
    }
  }
  if (candidates.length === 0) throw new Error("没有已启用时段的定时播放时间");
  candidates.sort((a, b) => a.delayMs - b.delayMs);
  return candidates[0];
}

function hourlyTargets(slot) {
  const start = minutesOfDay(slot.start);
  const end = minutesOfDay(slot.end);
  const duration = start < end ? end - start : 24 * 60 - start + end;
  if (duration <= 0) throw new Error(`slot ${slot.id} 时段长度非法`);
  const targets = [];
  for (let offset = 0; offset < duration; offset += 60) {
    targets.push((start + offset) % (24 * 60));
  }
  return targets;
}

function hhmmFromMinutes(minutes) {
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}
