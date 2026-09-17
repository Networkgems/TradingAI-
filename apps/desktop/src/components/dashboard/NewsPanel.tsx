// TRA-422 — the News tab body, extracted from Dashboard.tsx (a NewsCard list).
// The "loading" copy is a prop.
import type { NewsItem } from '@trading-app/shared';
import { NewsCard } from '../NewsCard';

export function NewsPanel({ news, loadingText }: { news: NewsItem[]; loadingText: string }) {
  return (
    <div className="signals-panel">
      {news.length === 0 ? (
        <div className="empty">{loadingText}</div>
      ) : (
        <div className="signal-list">
          {news.slice(0, 10).map(item => (
            <NewsCard key={item.id ?? item.url} item={item} />
          ))}
        </div>
      )}
    </div>
  );
}
