type PagePlaceholderProps = {
  title: string;
  reference?: string;
};

export default function PagePlaceholder({
  title,
  reference,
}: PagePlaceholderProps) {
  return (
    <div className="p-8">
      <h1
        className="mb-2 text-[22px] font-semibold text-[var(--text-primary)]"
        style={{ fontFamily: "'Prompt', sans-serif" }}
      >
        {title}
      </h1>
      <p className="text-sm text-[var(--text-muted)]">
        หน้านี้จะถูกพัฒนาต่อจาก reference HTML
        {reference ? (
          <>
            {' '}
            (
            <code className="rounded bg-[var(--g100)] px-1.5 py-0.5 text-xs">{reference}</code>
            )
          </>
        ) : null}
      </p>
    </div>
  );
}
