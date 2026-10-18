/**
 * 一次性脚本：把参考项目（XJTUToolBox）的通知源清单转成我们的形状。
 *
 * 参考项目的 `notification/sources.json` 里每个源带 `channels[]`（栏目 URL、
 * 是否默认开启、层级），这正是我们要的东西 —— 比 `web-search.js` 那张
 * `CAMPUS_SITE_SEARCH`（为**站内搜索**服务，多数站点没有栏目路径）更贴通知场景。
 *
 * 跑一次即可；产物 `src/modules/notifications/sources.json` 提交进仓库，
 * 免得运行时依赖网络。
 */

import { writeFile } from 'node:fs/promises';

const SHA = '8908bc3a1cced92d475ef7efa138ea6f3668e580';
const API = `https://api.github.com/repos/yan-xiaoo/XJTUToolBox/git/blobs/${SHA}`;

const response = await fetch(API, { headers: { 'User-Agent': 'xjtu-study-assistant' } });
if (!response.ok) throw new Error(`拉取参考清单失败：HTTP ${response.status}`);
const blob = await response.json();
const data = JSON.parse(Buffer.from(blob.content, 'base64').toString('utf8'));

// 根节点是对象，真正的数组在某处（不要写死键名，参考项目改过结构）
const list = Array.isArray(data)
  ? data
  : (data.sources ?? data.notifications ?? Object.values(data).find(Array.isArray) ?? []);
if (!Array.isArray(list) || !list.length) throw new Error('参考清单里找不到源数组');

const hostOf = (url) => {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
};

const out = [];
for (const source of list) {
  const channels = (source.channels ?? []).filter((channel) => channel && channel.url);
  // 没有栏目 URL 的源没法"直读栏目"，跳过（它们在参考项目里大概靠别的抓取方式）
  if (!channels.length) continue;
  out.push({
    id: source.id,
    label: source.name,
    category: source.category ?? '',
    host: hostOf(source.home ?? channels[0].url),
    home: source.home ?? null,
    needsChallenge: Boolean(source.needs_challenge),
    channels: channels.map((channel) => ({
      id: channel.id,
      label: channel.name,
      url: channel.url,
      level: channel.level ?? null,
      // 只有**显式 true** 才算默认开启：缺字段意味着参考项目没标它默认关注
      defaultOn: channel.default_on === true,
    })),
  });
}

await writeFile(new URL('../src/modules/notifications/sources.json', import.meta.url), JSON.stringify(out, null, 2), 'utf8');

const withDefault = out.filter((source) => source.channels.some((channel) => channel.defaultOn));
console.log(`源数 ${out.length}（含默认开启栏目 ${withDefault.length}），频道 ${out.reduce((n, s) => n + s.channels.length, 0)} 个`);
console.log(`默认开启：${withDefault.map((source) => `${source.id}(${source.label})`).join('、')}`);
