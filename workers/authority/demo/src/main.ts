import './style.css';

// The OAuth callback loads no third-party SDK, and removes the one-use code
// from the address bar before returning it to the originating demo window.
if (location.pathname === '/authority/callback') {
  const params = new URLSearchParams(location.search);
  history.replaceState(null, '', location.pathname);
  document.querySelector('main')!.textContent = window.opener
    ? 'GitHub 连接完成，请返回原窗口。'
    : '原登录窗口已关闭，请返回 Demo 重新连接 GitHub。';
  window.opener?.postMessage(
    {
      type: 'monoid-authority-github',
      code: params.get('code'),
      state: params.get('state'),
    },
    location.origin,
  );
} else {
  // Reown validates the SDK iframe's Referer. Send only our origin, never
  // page paths or query parameters; the OAuth callback keeps no-referrer.
  document.querySelector<HTMLMetaElement>('meta[name="referrer"]')!.content =
    'origin';
  import('./app.js').catch(() => {
    document.getElementById('status')!.textContent =
      '登录组件初始化失败，请刷新页面后重试。';
  });
}
