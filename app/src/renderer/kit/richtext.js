/**
 * 富文本渲染（classic script，零依赖、无构建）。
 *
 * 为什么自己写：本项目的 CSP 是 `default-src 'self'`，且零运行时依赖，
 * 引 MathJax / KaTeX / marked 都要外网 CDN 或 npm 安装 —— 都不成立。
 * 所以这里只做**够用的子集**，并且**一切以纯字符串 → HTML 字符串**的形式实现
 * （`toHtml()`），好处是可以在 node 里直接断言输出，不必依赖 DOM。
 *
 * 三块能力：
 *   1. Markdown 子集：标题 / 列表 / 引用 / 分隔线 / 粗斜体 / 行内代码 / 围栏代码 / 链接；
 *   2. LaTeX 子集：`$…$`、`$$…$$`、`\(…\)`、`\[…\]` 包裹的常见数学写法（见 renderMath）；
 *   3. ` ```svg ` 代码块 → 内联 SVG 图形（按 dschat2 的约定，见 sanitizeSvg）。
 *
 * 两条硬要求：
 *   - **绝不能抛异常**：模型输出是流式的，随时可能只有半截公式（`$\fra`）或半截围栏。
 *     所有解析遇到不成对/不认识的东西一律**当普通文本保留**，不许吞掉、不许报错；
 *   - **先转义再拼标签**：模型输出直接进 innerHTML，不转义就是把 XSS 交给模型。
 */

window.PCRichText = (function () {
  'use strict';

  const ESCAPE = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

  /** 图形还没接收完整时的占位（见 renderDiagramHtml 的说明）。 */
  const DIAGRAM_PENDING = '<div class="diagram diagram-pending">正在绘制…</div>';

  function escapeHtml(text) {
    return String(text ?? '').replace(/[&<>"']/g, (ch) => ESCAPE[ch]);
  }

  /* ------------------------------------------------------------ LaTeX 子集 */

  /** 命令 → 显示内容。希腊字母与常见算符直接用 Unicode，省掉数学字体。 */
  const SYMBOLS = {
    alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε', zeta: 'ζ',
    eta: 'η', theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν',
    xi: 'ξ', pi: 'π', varpi: 'ϖ', rho: 'ρ', sigma: 'σ', varsigma: 'ς', tau: 'τ', upsilon: 'υ',
    phi: 'φ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
    Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ',
    Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
    times: '×', div: '÷', pm: '±', mp: '∓', cdot: '·', ast: '∗', star: '⋆', circ: '∘',
    bullet: '•', oplus: '⊕', ominus: '⊖', otimes: '⊗',
    le: '≤', leq: '≤', ge: '≥', geq: '≥', ne: '≠', neq: '≠', equiv: '≡', approx: '≈',
    sim: '∼', simeq: '≃', propto: '∝', ll: '≪', gg: '≫', in: '∈', notin: '∉',
    subset: '⊂', subseteq: '⊆', supset: '⊃', supseteq: '⊇', cup: '∪', cap: '∩',
    emptyset: '∅', varnothing: '∅', forall: '∀', exists: '∃', nexists: '∄',
    neg: '¬', land: '∧', lor: '∨', therefore: '∴', because: '∵',
    infty: '∞', partial: '∂', nabla: '∇', angle: '∠', perp: '⊥', parallel: '∥',
    degree: '°', prime: '′', ldots: '…', cdots: '⋯', dots: '…', vdots: '⋮', ddots: '⋱',
    to: '→', rightarrow: '→', leftarrow: '←', leftrightarrow: '↔', Rightarrow: '⇒',
    Leftarrow: '⇐', Leftrightarrow: '⇔', mapsto: '↦', implies: '⟹', iff: '⟺',
    quad: '\u2003', qquad: '\u2003\u2003', ',': '\u2009', ';': '\u2009', ':': '\u2009', '!': '',
  };

  /** 大运算符：上下标要排在正上下方（求和、积分那种写法）。 */
  const BIG_OPS = { sum: '∑', prod: '∏', coprod: '∐', int: '∫', iint: '∬', iiint: '∭', oint: '∮', bigcup: '⋃', bigcap: '⋂' };

  /** 函数名：直立显示，不跟着斜体。 */
  const FUNCTIONS = new Set([
    'sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'arcsin', 'arccos', 'arctan',
    'sinh', 'cosh', 'tanh', 'log', 'ln', 'lg', 'exp', 'lim', 'max', 'min', 'sup', 'inf',
    'gcd', 'det', 'dim', 'ker', 'deg', 'mod', 'bmod',
  ]);

  /** 重音/上划线类命令：套在下一个组上。 */
  const ACCENTS = {
    vec: '→', bar: '‾', hat: '^', tilde: '~', dot: '˙', ddot: '¨',
    overline: '‾', underline: '_', widehat: '^', widetilde: '~',
  };

  const FONT_STYLES = { mathbb: 'm-bb', mathcal: 'm-cal', mathfrak: 'm-frak', mathbf: 'm-bf', mathrm: 'm-rm', mathit: 'm-it', boldsymbol: 'm-bf', text: 'm-text', textrm: 'm-text', operatorname: 'm-fn' };

  /**
   * 极简 TeX 解析：返回**内层** HTML（不含外层 `.math` 包裹）。
   *
   * 内层/外层分开是刻意的：分数、根号、上下限这些位置再套一层 `.math` 只会让
   * HTML 又深又难断言（`m-sub"><span class="math…` 这种），样式也更容易打架。
   * 不认识的命令原样保留（看得见才好排查，静默吞掉最难查）。
   */
  function parseMath(tex) {
    const source = String(tex ?? '');
    let i = 0;

    const peek = () => source[i];
    const eat = () => source[i++];

    /** 读一个「原子」：{组} / \命令 / 单字符。 */
    function readAtom() {
      skipSpaces();
      const ch = peek();
      if (ch === undefined) return '';
      if (ch === '{') return readGroup();
      if (ch === '\\') return readCommand();
      if (/[0-9.]/.test(ch)) {
        let num = '';
        while (peek() !== undefined && /[0-9.]/.test(peek())) num += eat();
        return escapeHtml(num);
      }
      if (/[a-zA-Z]/.test(ch)) {
        let word = '';
        while (peek() !== undefined && /[a-zA-Z]/.test(peek())) word += eat();
        return `<span class="m-var">${escapeHtml(word)}</span>`;
      }
      return escapeHtml(eat());
    }

    function readGroup() {
      if (peek() !== '{') return '';
      eat(); // {
      let depth = 1;
      let body = '';
      while (peek() !== undefined && depth > 0) {
        const ch = eat();
        if (ch === '{') depth += 1;
        else if (ch === '}') {
          depth -= 1;
          if (depth === 0) break;
        }
        body += ch;
      }
      // 组里可能还有上下标/分数，递归渲染
      return parseMath(body);
    }

    /** 读到「下一个原子」为止的原始 TeX（用于 \frac 的参数）。 */
    function readRawAtom() {
      skipSpaces();
      const ch = peek();
      if (ch === undefined) return '';
      if (ch === '{') {
        eat();
        let depth = 1;
        let body = '';
        while (peek() !== undefined && depth > 0) {
          const c = eat();
          if (c === '{') depth += 1;
          else if (c === '}') {
            depth -= 1;
            if (depth === 0) break;
          }
          body += c;
        }
        return body;
      }
      if (ch === '\\') {
        let out = eat();
        while (peek() !== undefined && /[a-zA-Z]/.test(peek())) out += eat();
        return out;
      }
      return eat();
    }

    function readCommand() {
      eat(); // backslash
      if (peek() === undefined) return '\\';
      if (!/[a-zA-Z]/.test(peek())) {
        // \% \{ \} \_ \& \$ \# 这类转义
        const ch = eat();
        return escapeHtml(ch === ' ' ? ' ' : ch);
      }
      let name = '';
      while (peek() !== undefined && /[a-zA-Z]/.test(peek())) name += eat();

      if (name === 'frac' || name === 'dfrac' || name === 'tfrac') {
        const num = parseMath(readRawAtom());
        const den = parseMath(readRawAtom());
        return `<span class="m-frac"><span class="m-num">${num}</span><span class="m-den">${den}</span></span>`;
      }
      if (name === 'sqrt') {
        let index = '';
        if (peek() === '[') {
          eat();
          let body = '';
          while (peek() !== undefined && peek() !== ']') body += eat();
          if (peek() === ']') eat();
          index = `<span class="m-root-index">${parseMath(body)}</span>`;
        }
        const radicand = parseMath(readRawAtom());
        return `<span class="m-sqrt">${index}<span class="m-radical">√</span><span class="m-radicand">${radicand}</span></span>`;
      }
      if (BIG_OPS[name]) {
        // 上下限：\sum_{i=1}^{n}
        let lower = '';
        let upper = '';
        for (let round = 0; round < 2; round += 1) {
          skipSpaces();
          if (peek() === '_' || peek() === '^') {
            const marker = eat();
            const value = parseMath(readRawAtom());
            if (marker === '_') lower = value;
            else upper = value;
          }
        }
        return (
          `<span class="m-bigop"><span class="m-lim m-lim-top">${upper}</span>` +
          `<span class="m-op">${BIG_OPS[name]}</span><span class="m-lim m-lim-bottom">${lower}</span></span>`
        );
      }
      if (ACCENTS[name]) {
        return `<span class="m-accent"><span class="m-accent-mark">${escapeHtml(ACCENTS[name])}</span><span class="m-accent-body">${parseMath(readRawAtom())}</span></span>`;
      }
      if (FONT_STYLES[name]) {
        return `<span class="${FONT_STYLES[name]}">${parseMath(readRawAtom())}</span>`;
      }
      if (FUNCTIONS.has(name)) return `<span class="m-fn">${escapeHtml(name)}</span>`;
      if (SYMBOLS[name] !== undefined) {
        const value = SYMBOLS[name];
        return value ? `<span class="m-sym">${escapeHtml(value)}</span>` : '';
      }
      if (name === 'left' || name === 'right') {
        skipSpaces();
        const ch = peek();
        if (ch === undefined) return '';
        if (ch === '\\') return readCommand(); // \left\{ \right\}
        if (ch === '.') {
          eat();
          return '';
        }
        eat();
        return `<span class="m-delim">${escapeHtml(ch)}</span>`;
      }
      if (name === 'begin' || name === 'end') {
        // 环境（矩阵/分段函数）暂不支持：把命令原样显示，别假装渲染成功
        return `<span class="m-unknown">\\${escapeHtml(name)}</span>`;
      }
      // 未知命令：保留原文
      return `<span class="m-unknown">\\${escapeHtml(name)}</span>`;
    }

    function skipSpaces() {
      while (peek() === ' ') i += 1;
    }

    /** 主循环：原子 + 上下标。 */
    function renderSequence() {
      let html = '';
      for (;;) {
        skipSpaces();
        const ch = peek();
        if (ch === undefined || ch === '}' || ch === '&') break;
        if (ch === '^' || ch === '_') {
          eat();
          const value = parseMath(readRawAtom());
          html += ch === '^' ? `<sup class="m-sup">${value}</sup>` : `<sub class="m-sub">${value}</sub>`;
          continue;
        }
        html += readAtom();
      }
      return html;
    }

    return renderSequence();
  }

  /** 对外入口：加一层 `.math` 包裹（行内还是块级由调用方决定）。 */
  function renderMath(tex, { display = false } = {}) {
    const cls = display ? 'math math-block' : 'math math-inline';
    return `<span class="${cls}">${parseMath(tex)}</span>`;
  }

  /* ------------------------------------------------------------ Markdown 子集 */

  /** 行内元素：先转义，再按固定顺序替换（粗体优先于斜体）。 */
  function renderInline(text) {
    let out = escapeHtml(text);
    out = out.replace(/`([^`]+)`/g, (m, code) => `<code class="rt-code">${code}</code>`);
    out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    out = out.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    out = out.replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a class="rt-link" href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
    );
    return out;
  }

  /**
   * 保护公式：先把 `$…$` 等整段换成占位符，等 Markdown 处理完再换回来。
   * 这样公式里的 `*` `_` `{` 不会被 Markdown 规则误伤（dschat2 也是这个套路）。
   */
  const MATH_RE = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|\$([^$\n]+?)\$/g;

  function protectMath(text, store) {
    return text.replace(MATH_RE, (match, block1, block2, inline1, inline2) => {
      const display = block1 !== undefined || block2 !== undefined;
      const tex = block1 ?? block2 ?? inline1 ?? inline2 ?? '';
      store.push(renderMath(tex, { display }));
      return `\u0000MATH${store.length - 1}\u0000`;
    });
  }

  function restoreMath(html, store) {
    return html.replace(/\u0000MATH(\d+)\u0000/g, (m, idx) => store[Number(idx)] ?? '');
  }

  /**
   * 整段渲染：围栏代码块 → 表格与其它按行分块 → 行内元素。
   * 返回 HTML 字符串。
   */
  function toHtml(text) {
    const source = String(text ?? '');
    const store = [];
    const lines = source.split('\n');
    const blocks = [];
    let buffer = [];
    let list = null; // { ordered, items }

    const flushParagraph = () => {
      if (!buffer.length) return;
      const raw = buffer.join('\n');
      blocks.push(`<p class="rt-p">${restoreMath(renderInline(protectMath(raw, store)), store)}</p>`);
      buffer = [];
    };
    const flushList = () => {
      if (!list) return;
      const tag = list.ordered ? 'ol' : 'ul';
      const items = list.items
        .map((item) => `<li>${restoreMath(renderInline(protectMath(item, store)), store)}</li>`)
        .join('');
      blocks.push(`<${tag} class="rt-list">${items}</${tag}>`);
      list = null;
    };
    // Split only unescaped pipes outside inline code; cell content still goes through
    // the same escaping and math protection as paragraphs.
    const tableCells = (row) => {
      const raw = row.trim(); const cells = []; let cell = ''; let ticks = 0;
      for (let i = 0; i < raw.length; i += 1) {
        const ch = raw[i];
        if (ch === '\\' && raw[i + 1] === '|') { cell += '|'; i += 1; continue; }
        if (ch === '`') {
          let run = 1; while (raw[i + run] === '`') run += 1;
          ticks = ticks === run ? 0 : ticks || run; cell += '`'.repeat(run); i += run - 1; continue;
        }
        if (ch === '|' && !ticks) { cells.push(cell.trim()); cell = ''; } else cell += ch;
      }
      cells.push(cell.trim());
      if (raw.startsWith('|')) cells.shift();
      if (raw.endsWith('|') && !raw.endsWith('\\|')) cells.pop();
      return cells;
    };

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];

      // 围栏代码块（含 ```svg 图形）
      const fence = line.match(/^\s*```(\w*)\s*$/);
      if (fence) {
        flushParagraph();
        flushList();
        const lang = fence[1] || '';
        const body = [];
        index += 1;
        while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
          body.push(lines[index]);
          index += 1;
        }
        const code = body.join('\n');
        if (lang.toLowerCase() === 'svg') blocks.push(renderDiagramHtml(code));
        else {
          const cls = lang ? ` class="language-${escapeHtml(lang)}"` : '';
          blocks.push(`<pre class="rt-pre"><code${cls}>${escapeHtml(code)}</code></pre>`);
        }
        continue;
      }

      const headers = line.includes('|') ? tableCells(line) : [];
      const separators = tableCells(lines[index + 1] || '');
      if (headers.length && headers.length === separators.length && separators.every((cell) => /^:?-{3,}:?$/.test(cell))) {
        flushParagraph(); flushList();
        const alignments = separators.map((cell) => cell.startsWith(':') && cell.endsWith(':') ? 'rt-align-center' : cell.endsWith(':') ? 'rt-align-right' : '');
        const rowHtml = (cells, tag) => `<tr>${headers.map((unused, col) => {
          const cls = alignments[col] ? ` class="${alignments[col]}"` : '';
          return `<${tag}${cls}>${restoreMath(renderInline(protectMath(cells[col] || '', store)), store)}</${tag}>`;
        }).join('')}</tr>`;
        const rows = []; index += 1;
        while (index + 1 < lines.length && lines[index + 1].includes('|') && lines[index + 1].trim()) rows.push(rowHtml(tableCells(lines[++index]), 'td'));
        blocks.push(`<div class="rt-table-wrap"><table class="rt-table"><thead>${rowHtml(headers, 'th')}</thead><tbody>${rows.join('')}</tbody></table></div>`);
        continue;
      }

      // 分隔线
      if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) {
        flushParagraph();
        flushList();
        blocks.push('<hr class="rt-hr">');
        continue;
      }

      // 标题
      const heading = line.match(/^\s*(#{1,6})\s+(.*)$/);
      if (heading) {
        flushParagraph();
        flushList();
        const level = Math.min(heading[1].length + 2, 6); // 聊天里不需要 h1/h2 那么大
        blocks.push(`<h${level} class="rt-h">${restoreMath(renderInline(protectMath(heading[2], store)), store)}</h${level}>`);
        continue;
      }

      // 引用
      if (/^\s*>\s?/.test(line)) {
        flushParagraph();
        flushList();
        const quote = [line.replace(/^\s*>\s?/, '')];
        while (index + 1 < lines.length && /^\s*>\s?/.test(lines[index + 1])) {
          index += 1;
          quote.push(lines[index].replace(/^\s*>\s?/, ''));
        }
        blocks.push(`<blockquote class="rt-quote">${restoreMath(renderInline(protectMath(quote.join('\n'), store)), store)}</blockquote>`);
        continue;
      }

      // 列表
      const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
      const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
      if (bullet || numbered) {
        flushParagraph();
        const ordered = Boolean(numbered);
        if (!list || list.ordered !== ordered) {
          flushList();
          list = { ordered, items: [] };
        }
        list.items.push((bullet ?? numbered)[1]);
        continue;
      }

      if (!line.trim()) {
        flushParagraph();
        flushList();
        continue;
      }

      flushList();
      buffer.push(line);
    }
    flushParagraph();
    flushList();

    return blocks.join('');
  }

  /* ------------------------------------------------------------ SVG 图形 */

  /**
   * 清理 SVG 里的危险/无效内容。
   *
   * 与 dschat2 的 sanitizeSvg 一致（去 script / foreignObject / iframe / object / embed / on* / javascript:），
   * 另外**去掉 style 属性**：本项目的 CSP 是 `style-src 'self'`，内联样式属性会被浏览器拦掉，
   * 留着只会让图形"看起来少了颜色"，不如直接去掉并让模型用表现属性（fill= / stroke=）。
   */
  function sanitizeSvg(src) {
    return String(src ?? '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, '')
      .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
      .replace(/<object[\s\S]*?<\/object>/gi, '')
      .replace(/<embed[\s\S]*?<\/embed>/gi, '')
      .replace(/<animate[\s\S]*?<\/animate[^>]*>/gi, '')
      .replace(/<set[\s\S]*?>/gi, '')
      .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
      .replace(/\sstyle\s*=\s*("[^"]*"|'[^']*')/gi, '')
      .replace(/javascript:/gi, '');
  }

  /**
   * ` ```svg ` → 内联图形。
   * 没有 viewBox 就补一个默认的（不然尺寸会乱）；顶层没有 fill 就补 `currentColor`，
   * 这样在深色主题下，模型忘了写颜色的文字与填充也是可见的。
   */
  function renderDiagramHtml(source) {
    let svg = sanitizeSvg(source).trim();
    if (!svg) return '';
    // 模型偶尔把注释/说明写在围栏里，先截到第一个 <svg
    const start = svg.toLowerCase().indexOf('<svg');
    if (start > 0) svg = svg.slice(start);

    // 流式过程中图形必然是半截的：这时**不能**把残缺标签塞进 innerHTML ——
    // 浏览器会把后续内容（包括我们自己加的 </div>）当成未闭合标签的属性值，
    // 于是刷一屏 "Expected length, </div"，画面还在闪垃圾。
    if (/<svg[\s>]/i.test(svg)) {
      if (!/<\/svg>\s*$/i.test(svg)) return DIAGRAM_PENDING;
    } else if (/<[^>]*$/.test(svg)) {
      // 没有 <svg> 的裸元素（模型只给了子元素）：截断在标签中间时同样先不画
      return DIAGRAM_PENDING;
    }

    if (!/^<svg[\s>]/i.test(svg)) {
      svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300">${svg}</svg>`;
    }
    // 补 viewBox
    if (!/viewbox=/i.test(svg.slice(0, svg.indexOf('>') + 1))) {
      svg = svg.replace(/<svg\b/i, '<svg viewBox="0 0 400 300"');
    }
    // 补默认颜色（根节点上的 fill 会被子元素继承）
    if (!/\sfill=/i.test(svg.slice(0, svg.indexOf('>') + 1))) {
      svg = svg.replace(/<svg\b/i, '<svg fill="currentColor"');
    }
    return `<div class="diagram">${svg}</div>`;
  }

  /** 渲染进元素：唯一会碰 DOM 的函数（其余都是纯字符串，便于单测）。 */
  function render(el, text) {
    if (!el) return el;
    el.innerHTML = toHtml(text);
    return el;
  }

  return { toHtml, render, renderMath, sanitizeSvg, escapeHtml };
})();
