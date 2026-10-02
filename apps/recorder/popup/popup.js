// 打开中台：优先切回发起录制的用例详情页 tab，无会话或 tab 已关则新开中台首页
document.getElementById('open').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'open-console' });
});
