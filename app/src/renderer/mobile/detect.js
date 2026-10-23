/**
 * 手机外壳的开关：在 <head> 里尽早判定，给 <html> 挂上 `m-app`，避免首帧先画出桌面三栏。
 *
 * 断点与 shell/app.js 的 MOBILE_QUERY 一致（760px）。判定只在加载时做一次：
 * 手机横屏（宽度 > 760）时仍保持手机外壳，手机外壳本身是流式布局，横屏照样可用。
 */
(function () {
  'use strict';
  const active = Boolean(window.matchMedia?.('(max-width: 760px)')?.matches);
  window.PCMobileActive = active;
  if (active) document.documentElement?.classList?.add?.('m-app');
})();
