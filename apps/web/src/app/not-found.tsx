import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="fallback-page">
      <div className="empty">
        <div className="empty-title">页面不存在</div>
        <div className="empty-sub">你访问的地址可能已被删除或输入有误。</div>
        <div className="fallback-actions">
          <Link className="btn" href="/">
            返回工作台
          </Link>
        </div>
      </div>
    </main>
  );
}
