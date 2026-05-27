type PagePlaceholderProps = {
  title: string;
  reference?: string;
};

export default function PagePlaceholder({
  title,
  reference,
}: PagePlaceholderProps) {
  return (
    <div className="page-placeholder">
      <h1>{title}</h1>
      <p>
        หน้านี้จะถูกพัฒนาต่อจาก reference HTML
        {reference ? (
          <>
            {' '}
            (<code>{reference}</code>)
          </>
        ) : null}
      </p>
    </div>
  );
}
