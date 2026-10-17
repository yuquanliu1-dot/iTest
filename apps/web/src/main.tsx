import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NuqsAdapter } from 'nuqs/adapters/react-router/v6';
import App from './App';
import { ApiError } from './api/client';
import './index.css';
import './i18n';
import { applyHtmlLang, readStoredLang } from './i18n';

applyHtmlLang(readStoredLang());

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // 4xx 是确定性失败（404 不存在/不可见、400 参数错），重试只会让页面白转圈；
      // 5xx 与网络错误保留默认 3 次重试
      retry: (failureCount, error) => {
        if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
        return failureCount < 3;
      },
    },
  },
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <NuqsAdapter>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </NuqsAdapter>
    </QueryClientProvider>
  </React.StrictMode>,
);