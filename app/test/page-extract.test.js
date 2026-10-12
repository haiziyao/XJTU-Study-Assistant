/**
 * 正文抓取：站内正文容器 / 整页清洗 / meta 摘要兜底。
 *
 * 这一组测试来源于一个真实的产品缺陷（2026-10-13 定位）：校内一类页面
 * （博达 VSB 站群的新模板，如 `https://sae.xjtu.edu.cn/info/1024/1173.htm`）
 * 抓回来**只有 865 字导航**，模型只能看到标题与发布日期，答不出"谁来了、谈了什么"。
 *
 * 根因不是"JS 之后才加载正文"（那个页面的正文就在 HTML 里，在 `<div id="vsb_content">` 中），
 * 而是两条清洗规则叠在一起把正文吃掉了：
 *   1. `DROP_TAGS` 里有 `form` —— 而 VSB 把**整篇文章**包在
 *      `<form name="_newscontent_fromname">` 里，于是"丢掉 form 连带内容"把正文整块删了；
 *   2. 同一页有**两份完整重复的导航**（PC + 移动端）与页脚，正文被删后剩下的就只有菜单。
 *
 * 所以这里钉住三件事：
 *   - 正文容器**优先于**整页清洗（容器外的导航再多也不许顶掉正文）；
 *   - 容器 / 整页都拿不到内容时，才回退到 `<meta name="description">`；
 *   - 摘要兜底**必须**带上 `via` / `note` 来源标记 —— 模型分不清"读完了全文"和
 *     "只看到两百字摘要"时，就会承诺摘要里没有的细节。
 *
 * 零真实外网：所有请求都走 `localOnlyFetch()`（打到非 127.0.0.1 会直接抛错）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import {
  META_DESCRIPTION_NOTE,
  PAGE_TEXT_MIN_CHARS,
  PAGE_TEXT_VIA,
  extractMetaDescription,
  extractPage,
  extractPageText,
  readPages,
} from '../src/modules/ai/web-search.js';

const realFetch = globalThis.fetch;

/** 只允许打到 127.0.0.1 的 fetch 包装：忘记注入它就会立刻暴露，而不是偷偷联网。 */
function localOnlyFetch(record = []) {
  return async (url, init = {}) => {
    const target = String(url);
    const host = new URL(target).hostname;
    if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
      throw new Error(`测试禁止访问真实网络：${target}`);
    }
    record.push({ url: target, method: init.method ?? 'GET', headers: init.headers ?? {} });
    return realFetch(target, init);
  };
}

/** 起一个本地假服务器；handler 拿到解析好的 `(url, finish, state)`。 */
async function startFakeServer(handler) {
  const state = { requests: [] };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    state.requests.push({ method: req.method, path: url.pathname, query: url.searchParams });
    const finish = (status, payload, type = 'text/html; charset=utf-8') => {
      res.writeHead(status, { 'Content-Type': type });
      res.end(payload);
    };
    Promise.resolve(handler({ url, req, state, finish })).catch((error) => finish(500, String(error)));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, state, close: () => new Promise((resolve) => server.close(resolve)) };
}

// ---------------------------------------------------------------------------
// 假页面构造（形状照 VSB 新模板复刻）
// ---------------------------------------------------------------------------

/** 一整份导航（PC 一份、移动端一份，所以同一个词会出现两遍）。 */
const NAV = `
<nav>首页 | 学院概况 | 师资队伍 | 人才培养 | 科学研究 | 学生风采</nav>
<div class="menu">学校首页 加入收藏 English 学院概况 学院简介 机构设置 领导团队 党建工作 组织机构</div>
<div class="menu-m">学校首页 加入收藏 English 学院概况 学院简介 机构设置 领导团队 党建工作 组织机构</div>
<footer><p>地址：陕西省西安市碑林区咸宁西路28号 邮编：710049</p><p>版权所有：西安交通大学</p></footer>`;

function metaDescription(text) {
  return `<META Name="description" Content="${text}" />`;
}

/**
 * "只有导航 + meta 摘要"的页面：正文**真的不在 HTML 里**（纯脚本渲染 / 需要登录的模板）。
 * 注意：这种页面即使把导航全抓回来也有 200 字以上 —— 所以"过短"不能只看字数。
 */
function navOnlyHtml({ description = '', title = '工作动态-西安交通大学航天航空学院' } = {}) {
  return `<!doctype html><html><head><meta charset="UTF-8"><title>${title}</title>
${description ? metaDescription(description) : ''}
<script type="text/javascript">_jsq_(1024,'/content.jsp',1173,1940881638)</script>
</head><body>${NAV}
<div id="main"><div class="position">当前位置： 党建工作 工作动态 正文</div></div>
</body></html>`;
}

/** "正文在容器里"的页面：形状照 VSB 复刻（正文包在 form 里，外面还有两份导航）。 */
function containerHtml({ paragraphs = [], description = '', title = '中国工程物理研究院流体物理研究所来访航天航空学院并做技术交流' } = {}) {
  return `<!doctype html><html><head><meta charset="UTF-8"><title>${title}</title>
${description ? metaDescription(description) : ''}
<script type="text/javascript">_jsq_(1024,'/content.jsp',1173,1940881638)</script>
</head><body>
${NAV}
<form name="_newscontent_fromname">
    <h3>${title}</h3>
    <div class="c-info"><span>发布时间：2019-06-24</span></div>
    <div id="vsb_content" class="c-tx"><html><body>
      <div class="v_news_content">
        ${paragraphs.map((text) => `<p>${text}</p>`).join('\n')}
      </div>
    </body></html></div>
    <div class="c-btn"><a href="1174.htm">上一篇</a><a href="1172.htm">下一篇</a></div>
</form>
</body></html>`;
}

/** "普通站点"：没有站内正文容器，正文直接在 body 里。 */
function plainArticleHtml({ paragraphs = [], description = '', title = '一篇普通的文章' } = {}) {
  return `<!doctype html><html><head><meta charset="UTF-8"><title>${title}</title>
${description ? `<meta name="description" content="${description}">` : ''}
</head><body>
<nav>首页 | 概况 | 师资 | 招生</nav>
<header>站内搜索</header>
<h1>${title}</h1>
${paragraphs.map((text) => `<p>${text}</p>`).join('\n')}
<footer>版权所有 © 西安交通大学</footer>
</body></html>`;
}

/**
 * 一篇真实长度的校内新闻（三段、合计远超 `PAGE_TEXT_MIN_CHARS`）。
 * 篇幅取真实值是有意的：`PAGE_TEXT_MIN_CHARS` 就是"这点字够不够回答用户"的闸门，
 * 拿 160 字的三句话去测"正常正文页"，测的其实是"短文页走不走摘要兜底"，不是这条。
 */
const ARTICLE_PARAGRAPHS = [
  '6月21日，中国工程物理研究院流体物理研究所汤铁钢副所长、桂毓林副主任、裴晓阳副主任等一行7人到访航天航空学院，进行技术交流，并就人才培养和科学研究方面的合作展开洽谈。航天学院申胜平院长、徐自力书记及部分教师代表出席会议并接待了到访人员。',
  '申胜平院长首先代表学院欢迎中国工程物理研究院汤铁钢副所长一行7人的到来，希望双方能在人才培养、科学研究方面加强沟通，开展合作并形成常态化机制，欢迎毕业校友常回学校看看。',
  '在技术交流环节，流体物理研究所副研究员于继东做了题为《金属材料动力学行为研究简介》的报告，副研究员陈咏龙做了题为《流体物理研究所爆轰物理领域研究进展与能力介绍》的报告。航天学院秦庆华教授、董龙雷副教授介绍了自己所在团队目前的研究领域，研究背景及选题意义和研究成果。',
];

// ---------------------------------------------------------------------------
// 1. 只有导航 + meta 摘要 → 摘要兜底，且来源标记正确
// ---------------------------------------------------------------------------

test('只有导航 + meta description 的页面：回退取摘要，并标明 via=meta-description / note', () => {
  const description = '6月21日，中国工程物理研究院流体物理研究所汤铁钢副所长等一行7人到访航天航空学院，进行技术交流。';
  const page = extractPage(navOnlyHtml({ description }));

  assert.equal(page.via, PAGE_TEXT_VIA.meta, '必须标明这段来自 meta 摘要');
  assert.equal(page.usedMeta, true);
  assert.equal(page.note, META_DESCRIPTION_NOTE, 'note 要明确告诉模型"这是摘要，不是全文"');
  assert.match(page.note, /摘要/);
  assert.match(page.note, /不是正文全文/);
  assert.ok(page.text.includes(description), '摘要内容要真的带回来');
  assert.ok(page.text.includes('汤铁钢'), '模型要能看到"谁来了"');
});

test('摘要兜底：og:description 与属性顺序颠倒 / 单引号 / 裸值都认', () => {
  const cases = [
    '<meta property="og:description" content="摘要甲">',
    '<meta content="摘要乙" name="description">',
    "<meta name='description' content='摘要丙'>",
    '<META Name="Description" Content="摘要丁" />',
    '<meta name=description content=摘要戊>',
  ];
  const values = ['摘要甲', '摘要乙', '摘要丙', '摘要丁', '摘要戊'];
  cases.forEach((meta, index) => {
    const html = `<!doctype html><html><head>${meta}</head><body><nav>首页 | 概况</nav></body></html>`;
    assert.equal(extractMetaDescription(html), values[index], `没认出第 ${index + 1} 种写法：${meta}`);
    assert.equal(extractPage(html).via, PAGE_TEXT_VIA.meta);
  });
  // 没有 description 时不能瞎认
  assert.equal(extractMetaDescription('<meta name="keywords" content="西安交通大学">'), '');
  assert.equal(extractMetaDescription('<meta name="description" content="">'), '');
});

test('摘要兜底：正文里出现 "name=description" 的字样不会被误当元信息', () => {
  const page = extractPage('<html><body><p>name=description 只是代码片段，content=不该被当成摘要</p></body></html>');
  assert.equal(page.via, PAGE_TEXT_VIA.body, '这是正文，不该走摘要兜底');
  assert.equal(page.usedMeta, false);
  assert.equal(page.note, null);
});

// ---------------------------------------------------------------------------
// 2. 正常有正文的页面 → 不受影响（绝不被摘要覆盖）
// ---------------------------------------------------------------------------

test('正常有正文的页面：取到正文，via=body，摘要不参与', () => {
  const html = plainArticleHtml({
    paragraphs: ARTICLE_PARAGRAPHS,
    description: '这是 meta 摘要，绝不该盖掉正文。',
  });
  const page = extractPage(html);

  assert.equal(page.via, PAGE_TEXT_VIA.body);
  assert.equal(page.usedMeta, false);
  assert.equal(page.note, null, '走正文时不该带"这是摘要"的 note');
  assert.ok(page.text.includes(ARTICLE_PARAGRAPHS[0]));
  assert.ok(page.text.includes(ARTICLE_PARAGRAPHS[2]), '三段正文都要在');
  assert.equal(page.text.includes('这是 meta 摘要'), false, '正文够长时摘要不许混进来');
  assert.equal(page.text.includes('版权所有'), false, '页脚噪声照旧去掉');
  assert.equal(page.text.includes('站内搜索'), false, 'header 照旧去掉');
});

test('正文很长（> 200 字）且同时带 meta description：仍用正文，摘要只做兜底', () => {
  const long = '正文段落内容，'.repeat(60); // 远超 PAGE_TEXT_MIN_CHARS
  assert.ok(long.length > PAGE_TEXT_MIN_CHARS);
  const page = extractPage(plainArticleHtml({ paragraphs: [long], description: '短摘要' }));

  assert.equal(page.via, PAGE_TEXT_VIA.body);
  assert.equal(page.usedMeta, false);
  assert.ok(page.text.length > PAGE_TEXT_MIN_CHARS);
  assert.equal(page.text.includes('短摘要'), false, '摘要不许拼进长正文');
});

// ---------------------------------------------------------------------------
// 3. 站内正文容器：真·正文，且导航不许顶掉它
// ---------------------------------------------------------------------------

test('正文容器：VSB 模板（正文包在 form 里 + 两份导航）抓到的是正文，不是导航', () => {
  const page = extractPage(containerHtml({ paragraphs: ARTICLE_PARAGRAPHS }));

  assert.equal(page.via, PAGE_TEXT_VIA.container, '命中 #vsb_content 要标成 container');
  assert.equal(page.usedMeta, false);
  assert.ok(page.text.includes('汤铁钢'), '正文里的人名必须抓到');
  assert.ok(page.text.includes('申胜平'));
  assert.ok(page.chars > 100);
  // 这一条正是原缺陷：以前返回的就是这些菜单词
  assert.equal(page.text.includes('学院概况'), false, '容器外的导航不许出现在结果里');
  assert.equal(page.text.includes('加入收藏'), false);
  assert.equal(page.text.includes('版权所有'), false);
});

test('正文容器：外面导航比正文长也不用导航（不按字数挑）', () => {
  const longNav = `<div class="menu">${'学校首页 学院概况 师资队伍 人才培养 科学研究 '.repeat(20)}</div>`;
  const short = '正文很短但它是正文。';
  const html = `<!doctype html><html><head><title>t</title></head><body>${longNav}
<div id="vsb_content"><div class="v_news_content"><p>${short}</p></div></div>
${longNav}</body></html>`;
  const page = extractPage(html);

  assert.equal(page.via, PAGE_TEXT_VIA.container, '容器里有文字就必须用容器');
  assert.equal(page.text.includes(short), true);
  assert.equal(page.text.includes('学院概况'), false, '导航再长也不能顶掉正文');
  assert.equal(page.containerChars, short.length, '容器里的字数就是正文那点');
});

test('正文容器：内层 </div> 不许把正文截断（同层配对，不是"第一个 </div>"）', () => {
  const paragraphs = ['第一段正文甲。', '第二段正文乙。', '第三段正文丙。'];
  const page = extractPage(containerHtml({ paragraphs }));
  paragraphs.forEach((text) => assert.ok(page.text.includes(text), `被截断了：${text}`));
});

test('正文容器：只有 id 标记但内容为空时，不硬当正文（走兜底）', () => {
  const html = `<!doctype html><html><head><meta name="description" content="只有摘要可用"></head>
<body>${NAV}<div id="vsb_content"></div></body></html>`;
  const page = extractPage(html);
  assert.equal(page.via, PAGE_TEXT_VIA.meta, '空容器不算正文，要落回摘要兜底');
  assert.ok(page.text.includes('只有摘要可用'));
});

// ---------------------------------------------------------------------------
// 4. content.jsp 路径：**实测不通**（返回的是整页，不是正文片段）
// ---------------------------------------------------------------------------

test('content.jsp：实测形状带 urltype + wbtreeid + wbnewsid；缺 urltype 时站方回"无效的访问地址"', async () => {
  const world = await startFakeServer(({ url, finish, state }) => {
    if (url.pathname === '/content.jsp') {
      // 复刻真网行为（2026-10-13 实测）：
      //  - 带 urltype=news.NewsContentUrl → 200，但返回的是**整页 HTML**（不是片段）
      //  - 缺 urltype / 参数顺序不对     → 200 + 101 字节的"无效的访问地址"
      if (url.searchParams.get('urltype') !== 'news.NewsContentUrl') {
        return finish(200, '<html><body><p style="font-family: 宋体; font-size: 14px;">无效的访问地址</p></body></html>');
      }
      state.sawUrltype = true;
      return finish(200, navOnlyHtml({ description: '站方摘要' }));
    }
    return finish(404, '<html>nope</html>');
  });
  try {
    const shape = `${world.base}/content.jsp?urltype=news.NewsContentUrl&wbtreeid=1024&wbnewsid=1173`;
    const [good, bad] = await readPages(
      [{ title: '正参数', url: shape }, { title: '缺 urltype', url: `${world.base}/content.jsp?wbtreeid=1024&wbnewsid=1173` }],
      { fetchImpl: localOnlyFetch(), limit: 2 },
    );
    assert.equal(world.state.sawUrltype, true, '请求要带上 urltype');
    // 关键结论：即使参数正确，content.jsp 给的仍是整页 —— 所以它**不能**当正文接口用
    assert.equal(good.ok, true);
    assert.equal(good.text.includes('无效的访问地址'), false);
    assert.ok(good.text.includes('站方摘要'));
    assert.equal(bad.ok, true, '"无效的访问地址"也是一页，不算读取失败');
    assert.ok(bad.text.includes('无效的访问地址'));
  } finally {
    await world.close();
  }
});

test('content.jsp：500 时静默回退到摘要兜底，不抛异常、不拖垮整批', async () => {
  const world = await startFakeServer(({ url, finish }) => {
    if (url.pathname === '/content.jsp') return finish(500, '<html>server error</html>');
    if (url.pathname === '/page') return finish(200, navOnlyHtml({ description: '这一页的摘要' }));
    return finish(404, '<html>nope</html>');
  });
  try {
    const pages = await readPages(
      [
        { title: '接口挂了', url: `${world.base}/content.jsp?urltype=news.NewsContentUrl&wbtreeid=1024&wbnewsid=1173` },
        { title: '正常页', url: `${world.base}/page` },
      ],
      { fetchImpl: localOnlyFetch(), limit: 2 },
    );
    assert.equal(pages.length, 2, '一条都不能少');
    assert.equal(pages[0].ok, false, '500 要如实报错');
    assert.match(pages[0].error, /500/);
    assert.equal(pages[1].ok, true, '另一页照常返回');
    assert.equal(pages[1].via, PAGE_TEXT_VIA.meta);
    assert.equal(pages[1].note, META_DESCRIPTION_NOTE, 'note 必须一路传到 readPages 的返回里');
  } finally {
    await world.close();
  }
});

// ---------------------------------------------------------------------------
// 5. readPages 的形状：via / note 一路传下去
// ---------------------------------------------------------------------------

test('readPages：via / note 跟着正文一起返回，失败条目也有这两个字段', async () => {
  const world = await startFakeServer(({ url, finish }) => {
    if (url.pathname === '/article') return finish(200, containerHtml({ paragraphs: ARTICLE_PARAGRAPHS }));
    if (url.pathname === '/summary') return finish(200, navOnlyHtml({ description: '只有摘要' }));
    if (url.pathname === '/boom') return finish(500, 'nope');
    if (url.pathname === '/empty') return finish(200, '<html><body></body></html>');
    return finish(404, 'nope');
  });
  try {
    const pages = await readPages(
      [
        { title: '正文页', url: `${world.base}/article` },
        { title: '摘要页', url: `${world.base}/summary` },
        { title: '挂了', url: `${world.base}/boom` },
        { title: '空页', url: `${world.base}/empty` },
      ],
      { fetchImpl: localOnlyFetch(), limit: 4 },
    );

    assert.deepEqual(pages.map((page) => page.via), [
      PAGE_TEXT_VIA.container,
      PAGE_TEXT_VIA.meta,
      PAGE_TEXT_VIA.body,
      PAGE_TEXT_VIA.body,
    ]);
    assert.equal(pages[0].note, null);
    assert.equal(pages[1].note, META_DESCRIPTION_NOTE);
    assert.equal(pages[2].note, null);
    assert.equal(pages[3].note, null);
    // 形状断言：模型侧投影表要按这两个字段名取（chat-service 的 web: […]）
    for (const page of pages) {
      assert.equal(typeof page.via, 'string', 'via 必须是字符串，别是 undefined');
      assert.ok('note' in page, 'note 必须在（可以为 null）');
    }
  } finally {
    await world.close();
  }
});

test('摘要兜底：maxChars 截断照旧生效，截断标记不被摘要逻辑吃掉', () => {
  const description = '摘'.repeat(500);
  const page = extractPage(navOnlyHtml({ description }), { maxChars: 100 });
  assert.equal(page.via, PAGE_TEXT_VIA.meta);
  assert.ok(page.text.length <= 100 + 80);
  assert.ok(page.text.includes('已按设置截断'));
});

test('兼容：extractPageText 仍返回字符串（老调用方不用改）', () => {
  assert.equal(typeof extractPageText(navOnlyHtml({ description: '摘要' })), 'string');
  assert.equal(extractPageText(''), '');
  assert.equal(extractPageText(undefined), '');
  assert.equal(extractPageText('<div>正文</div><style>p{}</style>', { maxChars: 100 }), '正文');
});

test('缺 meta 摘要 + 无正文：如实返回空结果，via 仍是 body（不假装读到摘要）', () => {
  const page = extractPage(navOnlyHtml({ description: '' }));
  assert.equal(page.usedMeta, false);
  assert.equal(page.note, null);
  // 导航页有内容，所以 text 非空 —— 但它没有被标成 meta，模型不会被误导成"读了摘要"
  assert.notEqual(page.via, PAGE_TEXT_VIA.meta);
  assert.equal(extractPage('<html><head></head><body></body></html>').text, '');
});
