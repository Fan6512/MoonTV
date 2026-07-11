'use client';

import dynamic from 'next/dynamic';
import { memo, useEffect, useState } from 'react';

const DownloadManager = dynamic(() => import('./DownloadManager'), {
  ssr: false,
});

/**
 * 全局下载管理器组件
 * 在根布局中渲染一次，被所有导航栏组件共享
 * 通过自定义事件进行通信
 */
const GlobalDownloadManager = () => {
  const [showDownloadManager, setShowDownloadManager] = useState(false);

  // 监听显示下载管理器的事件（从 TopNav 或 MobileHeader 触发）
  useEffect(() => {
    const handleShowEvent = () => setShowDownloadManager(true);
    
    if (typeof window !== 'undefined') {
      window.addEventListener('showDownloadManager', handleShowEvent);
    }

    return () => {
      if (typeof window !== 'undefined') {
        window.removeEventListener('showDownloadManager', handleShowEvent);
      }
    };
  }, []);

  return showDownloadManager ? (
    <DownloadManager
      isOpen={showDownloadManager}
      onClose={() => setShowDownloadManager(false)}
    />
  ) : null;
};

// 使用 React.memo 优化
export default memo(GlobalDownloadManager);
