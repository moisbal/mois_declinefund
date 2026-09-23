import type { ReactNode } from 'react';

type PageHeaderProps = {
  eyebrow?: string;
  title: string;
  description?: string;
  meta?: ReactNode;
  actions?: ReactNode;
  compact?: boolean;
};

export function PageHeader({ eyebrow, title, description, meta, actions, compact = false }: PageHeaderProps) {
  return (
    <header className={`work-page-header${compact ? ' work-page-header-compact' : ''}`}>
      <div className="work-page-heading">
        {eyebrow && <p className="work-eyebrow">{eyebrow}</p>}
        <h1>{title}</h1>
        {description && <p className="work-page-description">{description}</p>}
        {meta && <div className="work-page-meta">{meta}</div>}
      </div>
      {actions && <div className="work-page-actions">{actions}</div>}
    </header>
  );
}

export function SectionNav({ items }: { items: Array<{ href: string; label: string }> }) {
  return (
    <nav className="work-section-nav" aria-label="화면 내 이동">
      {items.map((item, index) => (
        <a key={item.href} href={item.href}>
          <span aria-hidden="true">{index + 1}</span>{item.label}
        </a>
      ))}
    </nav>
  );
}

export function SectionCard({
  id,
  title,
  description,
  actions,
  children,
}: {
  id?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section id={id} className="work-section-card">
      <div className="work-section-heading">
        <div>
          <h2>{title}</h2>
          {description && <p>{description}</p>}
        </div>
        {actions && <div className="work-section-actions">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

export function ReadonlyField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="work-field work-field-readonly">
      <span>{label}</span>
      <div>{children}</div>
    </div>
  );
}

export function StatusBadge({ label, tone = 'neutral' }: {
  label: string;
  tone?: 'neutral' | 'info' | 'success' | 'warning' | 'danger';
}) {
  return <span className={`work-status-badge ${tone}`}>{label}</span>;
}

export function AmountSummary({ items }: {
  items: Array<{ label: string; value: ReactNode; help?: string }>;
}) {
  return (
    <dl className="work-amount-summary">
      {items.map((item) => (
        <div key={item.label}>
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
          {item.help && <small>{item.help}</small>}
        </div>
      ))}
    </dl>
  );
}

export function EmptyState({ title, description }: { title: string; description?: string }) {
  return (
    <div className="work-state" role="status">
      <strong>{title}</strong>
      {description && <span>{description}</span>}
    </div>
  );
}

export function ErrorState({ children }: { children: ReactNode }) {
  return <div className="work-state error" role="alert">{children}</div>;
}

export function StickyActionBar({ status, actions }: { status: ReactNode; actions: ReactNode }) {
  return (
    <div className="work-sticky-action-bar">
      <div className="work-save-status" aria-live="polite">{status}</div>
      <div className="work-action-group">{actions}</div>
    </div>
  );
}
