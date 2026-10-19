'use client';

export default function ErrorPage({ reset }: { error: Error; reset: () => void }) {
  return (
    <main className="fallback-page">
      <div className="empty">
        <div className="empty-title">页面加载失败</div>
        <div className="empty-sub">发生了意外错误，请重试。若问题持续存在，请联系管理员。</div>
        <div className="fallback-actions">
          <button type="button" className="btn btn-primary" onClick={reset}>
            重试
          </button>
        </div>
      </div>
    </main>
  );
}
