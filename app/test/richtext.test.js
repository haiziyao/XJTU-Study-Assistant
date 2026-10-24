/**
 * 富文本渲染单测（公式 / Markdown / SVG 图形）。
 *
 * `kit/richtext.js` 是 classic script，且刻意做成**纯字符串 → HTML 字符串**
 * （只有一个 `render()` 碰 DOM），所以这里不搭 DOM 桩，直接在一个只带 `window` 的
 * vm 上下文里求值，然后断言 HTML 输出 —— 快、稳、不依赖浏览器。
 *
 * 重点覆盖三类"错了会很难看/很危险"的情况：
 *   1. LaTeX 子集渲染（含流式过程中必然出现的**半截公式**，不许抛异常、不许吞内容）；
 *   2. Markdown 与公式混排（公式里的 `*` `_` `{` 不能被 Markdown 规则误伤）；
 *   3. SVG 清理（脚本/事件/内联 style 必须被剥掉 —— 前者是 XSS，后者会被 CSP 拦成"没颜色"）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const SOURCE = await readFile(new URL('../src/renderer/kit/richtext.js', import.meta.url), 'utf8');

function loadRichText() {
  const sandbox = { window: {}, console };
  sandbox.globalThis = sandbox;
  vm.runInContext(SOURCE, vm.createContext(sandbox), { filename: 'richtext.js' });
  return sandbox.window.PCRichText;
}

const rt = loadRichText();

test('公式：行内与块级都被识别，且块级单独成块', () => {
  const inline = rt.toHtml('质能方程 $E=mc^2$ 很简洁');
  assert.match(inline, /math-inline/);
  assert.match(inline, /<sup class="m-sup">/);

  const block = rt.toHtml('推导如下：\n\n$$\\frac{a}{b}$$\n\n完毕');
  assert.match(block, /math-block/);
  assert.match(block, /m-frac/);
  assert.match(block, /m-num/);
  assert.match(block, /m-den/);
});

test('公式：分数 / 根号 / 大运算符 / 希腊字母 / 函数名 / 文本', () => {
  assert.match(rt.renderMath('\\frac{1}{2}'), /m-frac/);
  assert.match(rt.renderMath('\\sqrt{x+1}'), /m-radicand/);
  assert.match(rt.renderMath('\\sqrt[3]{x}'), /m-root-index/);

  const sum = rt.renderMath('\\sum_{i=1}^{n} i');
  assert.match(sum, /m-bigop/);
  assert.match(sum, /m-lim-top/);
  assert.match(sum, />n</);
  assert.match(sum, /m-lim-bottom/);
  // 单个字母会包成 .m-var，所以断言结构而不是裸文本
  assert.match(sum, /m-lim-bottom"><span class="m-var">i<\/span>=1/);

  assert.match(rt.renderMath('\\alpha\\beta\\Omega'), /α/);
  assert.match(rt.renderMath('\\alpha'), /β|α/);
  assert.match(rt.renderMath('\\sin x'), /class="m-fn">sin/);
  assert.match(rt.renderMath('\\text{当且仅当}'), /m-text/);
  assert.match(rt.renderMath('a \\le b \\ne c \\to d'), /≤/);
  assert.match(rt.renderMath('x \\in A \\cup B'), /∈/);
  assert.match(rt.renderMath('\\vec{v}'), /m-accent/);
});

test('公式：不认识的命令原样保留，不静默吞掉', () => {
  const html = rt.renderMath('\\foo{bar} + \\begin{cases}');
  assert.match(html, /m-unknown/);
  assert.match(html, /foo/);
  assert.match(html, /begin/);
});

test('流式：半截公式与不成对花括号不许抛异常，也不许丢内容', () => {
  const partials = ['$', '$\\', '$\\fra', '$\\frac{1', '$\\frac{1}{', '$$\\sqrt{', '`', '```', '```sv', '```svg\n<svg'];
  for (const text of partials) {
    const html = rt.toHtml(text);
    assert.equal(typeof html, 'string', `输入 ${JSON.stringify(text)} 应返回字符串`);
  }
  // 半截的 \frac{1 没有闭括号：整体当文本保留，用户能看到自己/模型打到哪了
  const html = rt.toHtml('结果是 $\\frac{1');
  assert.match(html, /frac|1/);
});

test('Markdown：标题 / 列表 / 引用 / 分隔线 / 粗斜体 / 行内代码', () => {
  const html = rt.toHtml(['## 小标题', '- 第一项', '- 第二项', '', '> 引用', '', '1. 有序', '', '---', '', '**粗** *斜* `code` ~~删~~'].join('\n'));
  assert.match(html, /<h4 class="rt-h">小标题<\/h4>/);
  assert.match(html, /<ul class="rt-list">/);
  assert.match(html, /<ol class="rt-list">/);
  assert.match(html, /<blockquote class="rt-quote">/);
  assert.match(html, /<hr class="rt-hr">/);
  assert.match(html, /<strong>粗<\/strong>/);
  assert.match(html, /<em>斜<\/em>/);
  assert.match(html, /<code class="rt-code">code<\/code>/);
  assert.match(html, /<del>删<\/del>/);
});

test('笔记排版：安全渲染字体、字号、颜色、下划线与段落对齐', () => {
  const html = rt.toHtml('{align:center}{font:kai}{size:24}{color:blue}{u}重点标题{/u}{/color}{/size}{/font}');
  assert.match(html, /rt-align-center/);
  assert.match(html, /rt-font-kai/);
  assert.match(html, /rt-size-24/);
  assert.match(html, /rt-color-blue/);
  assert.match(html, /<u>重点标题<\/u>/);

  const unsafe = rt.toHtml('{color:expression(alert(1))}内容{/color}');
  assert.equal(unsafe.includes('style='), false);
  assert.equal(unsafe.includes('expression('), true, '非法格式标记应作为普通文字保留');
});

test('Markdown：Obsidian Wiki 链接安全渲染标题、章节与别名', () => {
  const html = rt.toHtml('参见 [[牛顿定律#第二定律|F=ma]] 与 [[动量]]');
  assert.match(html, /class="rt-wikilink"/);
  assert.match(html, /data-note-title="牛顿定律"/);
  assert.match(html, /data-note-heading="第二定律"/);
  assert.match(html, />F=ma<\/span>/);
});

test('Markdown 与公式混排：公式里的 * _ { 不被误伤', () => {
  const html = rt.toHtml('注意 $a_b * c$ 这里的下标');
  assert.match(html, /m-sub/);
  const underscore = html.match(/m-sub"><span class="m-var">b<\/span>/);
  assert.ok(underscore, '下划线应渲染成下标');
  assert.equal(html.includes('<em>'), false, '公式里的 * 不该被当成斜体');
});

test('Markdown 表格：对齐、公式与转义分隔符安全渲染；未完整输入保留原文', () => {
  const html = rt.toHtml('| 记号 | **含义** |\n| :---: | ---: |\n| $\\lambda$ | <img src=x onerror=alert(1)> |\n| `a|b` | c\\|d |\n\n后续正文');
  assert.match(html, /<table class="rt-table">/);
  assert.match(html, /<th class="rt-align-center">记号/);
  assert.match(html, /<th class="rt-align-right"><strong>含义/);
  assert.match(html, /math-inline/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.equal(html.includes('<img'), false);
  assert.match(html, /<code class="rt-code">a\|b<\/code>/);
  assert.match(html, />c\|d<\/td>/);
  assert.match(html, /后续正文/);
  assert.equal(rt.toHtml('| 列一 | 列二 |\n| -- |').includes('<table'), false);
  assert.equal(rt.toHtml('```\n| A | B |\n| --- | --- |\n```').includes('<table'), false);
});

test('围栏代码块：普通代码保留原文并转义，svg 变成内联图形', () => {
  const code = rt.toHtml('```js\nconst a = 1 < 2;\n```');
  assert.match(code, /rt-pre/);
  assert.match(code, /language-js/);
  assert.match(code, /1 &lt; 2/);

  const diagram = rt.toHtml('```svg\n<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="#6c8cff"/></svg>\n```');
  assert.match(diagram, /<div class="diagram">/);
  assert.match(diagram, /<circle/);
});

test('SVG 清理：脚本 / 事件 / 内联 style / javascript: 全部剥掉', () => {
  const evil = [
    '<svg viewBox="0 0 10 10">',
    '<script>alert(1)</script>',
    '<foreignObject><div>hi</div></foreignObject>',
    '<rect width="10" height="10" onclick="alert(1)" style="fill:red"/>',
    '<a href="javascript:alert(1)">x</a>',
    '</svg>',
  ].join('');
  const html = rt.toHtml(`\`\`\`svg\n${evil}\n\`\`\``);
  assert.equal(/<script/i.test(html), false, 'script 必须被删');
  assert.equal(/foreignobject/i.test(html), false);
  assert.equal(/onclick/i.test(html), false, '事件属性必须被删');
  assert.equal(/style=/i.test(html), false, '内联 style 会被 CSP 拦掉，必须删');
  assert.equal(/javascript:/i.test(html), false);
  assert.match(html, /<rect/);
});

test('SVG 兜底：没有 viewBox 补一个，没有 fill 补 currentColor（深色主题才看得见）', () => {
  const html = rt.toHtml('```svg\n<svg><line x1="0" y1="0" x2="10" y2="10" stroke="#fff"/></svg>\n```');
  assert.match(html, /viewBox="0 0 400 300"/);
  assert.match(html, /fill="currentColor"/);

  const bare = rt.toHtml('```svg\n<circle cx="5" cy="5" r="2"/>\n```');
  assert.match(bare, /<svg[^>]*viewBox="0 0 400 300"/, '裸元素应被包进 svg');
  assert.match(bare, /<circle/);
});

test('XSS：普通文本里的标签被转义，不会当成 HTML 执行', () => {
  const html = rt.toHtml('用户说了 <img src=x onerror=alert(1)> 这样一句');
  assert.equal(/<img/i.test(html), false);
  assert.match(html, /&lt;img/);
  const script = rt.toHtml('<script>alert(1)</script>');
  assert.equal(/<script/i.test(script), false);
});

test('流式：半截 SVG 不注入，先给占位（否则浏览器会把后续内容当属性值，刷一屏报错）', () => {
  const partial = rt.toHtml('```svg\n<svg viewBox="0 0 10 10"><line x1="0" y1="0" x2=');
  assert.match(partial, /diagram-pending/);
  assert.equal(/<line/.test(partial), false, '残缺的标签不该被塞进 DOM');

  const complete = rt.toHtml('```svg\n<svg viewBox="0 0 10 10"><line x1="0" y1="0" x2="9" y2="9" stroke="#fff"/></svg>\n```');
  assert.equal(/diagram-pending/.test(complete), false);
  assert.match(complete, /<line/);
});

test('块级公式用 flex 居中（分数与两侧文字对齐，不靠基线）', async () => {
  const css = await readFile(new URL('../src/renderer/shell/shell.css', import.meta.url), 'utf8');
  const block = css.match(/\.math-block \{[\s\S]*?\n\}/);
  assert.ok(block, '应有 .math-block 规则');
  assert.match(block[0], /display: flex/);
  assert.match(block[0], /align-items: center/);
});
