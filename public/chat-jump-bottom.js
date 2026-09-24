// 聊天栏「直达底部」悬浮箭头：上翻历史超过阈值时浮现，点击平滑回底。
// 运行时把 #chat-messages 包进相对定位容器再注入按钮——按钮浮在滚动区
// 视口上而不随内容滚走；模块未加载时页面无任何痕迹。
// 不干预流式期间的自动滚底（book-chat.js scrollBottom）语义。
(function () {
  'use strict';

  var SHOW_THRESHOLD = 160; // 距底超过该像素才浮现

  function init() {
    var messages = document.getElementById('chat-messages');
    if (!messages || !messages.parentNode) return;

    var wrap = document.createElement('div');
    wrap.className = 'chat-scroll-wrap';
    messages.parentNode.insertBefore(wrap, messages);
    wrap.appendChild(messages);

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chat-jump-bottom';
    btn.title = '直达底部';
    btn.setAttribute('aria-label', '直达底部');
    btn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v14"/><path d="M6 12l6 6 6-6"/></svg>';
    wrap.appendChild(btn);

    // 判定走 rAF 节流：流式期间滚动/内容事件密集，避免每 token 读布局
    var ticking = false;
    function sync() {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(function () {
        ticking = false;
        var dist = messages.scrollHeight - messages.scrollTop - messages.clientHeight;
        btn.classList.toggle('show', dist > SHOW_THRESHOLD);
      });
    }

    btn.addEventListener('click', function () {
      messages.scrollTo({ top: messages.scrollHeight, behavior: 'smooth' });
    });
    messages.addEventListener('scroll', sync, { passive: true });
    // 换会话/重渲染整棵替换、窗口或分栏尺寸变化都要重判
    if (window.MutationObserver) new MutationObserver(sync).observe(messages, { childList: true });
    if (window.ResizeObserver) new ResizeObserver(sync).observe(messages);

    sync();
    window.ChatJumpBottom = { sync: sync };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
